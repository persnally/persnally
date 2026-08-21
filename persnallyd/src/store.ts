/**
 * EventStore — append-only SQLite event log plus rebuildable derived views.
 * Single source of truth per docs/EVENT_SCHEMA.md; views can always be re-derived.
 */

import Database from "better-sqlite3";
import { dirname, join } from "node:path";
import { topicWeight, type WeightSignal } from "./decay.js";
import { newEvent, normalizeTopic, validateEvent, type PersnallyEvent } from "./events.js";
import { loadConfig } from "./config.js";
import { DATA_DIR, ensurePrivateDir, ensurePrivateFile } from "./paths.js";
import { assemblePack, type StyleSignal } from "./stylometry.js";
import { groupNearDuplicates, TOPIC_MERGE_THRESHOLD } from "./topics.js";

// 4: topic rows fold near-duplicates, so an upgraded store must re-derive —
// otherwise the interest list keeps its split topics until the next signal write.
const VIEW_SCHEMA_VERSION = 4;

// One bind parameter per id, well under SQLite's 32k variable ceiling.
const MAX_ID_LOOKUP = 500;

export const DEFAULT_DB_PATH = join(DATA_DIR, "persnally.db");

/** Optional per-category half-life overrides from config, e.g.
    `{"decay_half_life_days": {"technology": 45}}`. Unset categories keep the
    defaults; anything malformed is ignored rather than corrupting the graph. */
function decayOverrides(): Record<string, number> {
  const raw = loadConfig().decay_half_life_days;
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "number" && Number.isFinite(v) && v > 0) out[k] = v;
  }
  return out;
}

export interface QueryOpts {
  type?: string;
  source?: string;
  since?: string;
  recordedSince?: string;
  limit?: number;
}

export interface TopicRow {
  topic_key: string;
  topic: string;
  category: string;
  signals: number;
  weight: number;
  sentiment_balance: number;
  dominant_intent: string;
  entities: string[];
  first_seen: string;
  last_seen: string;
  event_ids: string[];
}

export interface StoredProfile {
  headline: string;
  sections: { title: string; body: string; evidence_event_ids: string[] }[];
  generated_at: string;
  model: string;
}

export interface Activity {
  firstEventAt: string | null;     // onboarding proxy: first event of any kind
  firstReadAt: string | null;      // when context-serving actually began (first context.read)
  lastReadAt: string | null;
  daysSinceFirst: number;          // since onboarding
  daysSinceFirstRead: number;      // since serving began — the retention clock
  totalReads: number;
  reads7d: number;
  reads30d: number;
  activeDays7d: number;            // distinct days with ≥1 context.read
  activeDays14d: number;
  retainedWeek2: boolean | null;   // ≥1 read in days 8–14 after the FIRST read; null until that window has fully elapsed
  daily: { date: string; reads: number }[]; // last 14 days, oldest→newest
}

export interface AskRow {
  question_id: string;
  answer_id: string;
  ts: string;
  asker: string;
  question: string;
  answer: string;
  confidence: number;
  deferred: boolean;
  /** Empty for answers recorded before evidence was persisted. */
  evidence_event_ids: string[];
  verdict: "approved" | "edited" | "vetoed" | null;
}

export interface AskStats {
  asked: number;
  answered: number;
  deferred: number;
  approved: number;
  edited: number;
  vetoed: number;
  precision: number | null; // approved / labeled; edited and vetoed both count against — conservative on purpose
}

export class EventStore {
  private db: Database.Database;

  constructor(path: string = DEFAULT_DB_PATH) {
    ensurePrivateDir(dirname(path));
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    // WAL brings up -wal and -shm alongside the db; all three hold event data.
    for (const f of [path, `${path}-wal`, `${path}-shm`]) ensurePrivateFile(f);
    // The CLI and the daemon each open their own connection; a blocked writer
    // waits instead of failing fast with SQLITE_BUSY (better-sqlite3 defaults
    // to 5s — set explicitly with headroom for large rebuilds).
    this.db.pragma("busy_timeout = 10000");
    // Deletion is a product promise, not just a DML statement: without this,
    // freed pages keep their bytes and `strings persnally.db` still finds a
    // topic the user forgot. Overwrites freed content on every delete.
    this.db.pragma("secure_delete = ON");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id          TEXT PRIMARY KEY,
        ts          TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        source      TEXT NOT NULL,
        type        TEXT NOT NULL,
        payload     TEXT NOT NULL,
        provenance  TEXT NOT NULL,
        schema_ver  INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_events_ts   ON events (ts);
      CREATE INDEX IF NOT EXISTS idx_events_type ON events (type, ts);
      CREATE INDEX IF NOT EXISTS idx_events_src  ON events (source, ts);
      -- Consolidation selects by recorded_at (ingest time, not event time).
      CREATE INDEX IF NOT EXISTS idx_events_recorded ON events (recorded_at);
    `);
    // Views are derived state: on schema change, drop and re-derive rather than ALTER.
    const ver = (this.db.pragma("user_version", { simple: true }) as number) ?? 0;
    if (ver < VIEW_SCHEMA_VERSION) {
      // Every derived table, or a future bump silently keeps stale rows in the
      // one it forgot. They all re-derive: topics on rebuild(), profiles on
      // the next synthesis.
      this.db.exec(`
        DROP TABLE IF EXISTS view_topics;
        DROP TABLE IF EXISTS view_profile;
        DROP TABLE IF EXISTS view_scoped_profile;
        DROP TABLE IF EXISTS view_search;
      `);
      this.db.pragma(`user_version = ${VIEW_SCHEMA_VERSION}`);
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS view_topics (
        topic_key         TEXT PRIMARY KEY,
        topic             TEXT NOT NULL,
        category          TEXT NOT NULL,
        signals           INTEGER NOT NULL,
        weight            REAL NOT NULL,
        sentiment_balance REAL NOT NULL,
        dominant_intent   TEXT NOT NULL,
        entities          TEXT NOT NULL,
        first_seen        TEXT NOT NULL,
        last_seen         TEXT NOT NULL,
        event_ids         TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS view_profile (
        id           INTEGER PRIMARY KEY CHECK (id = 1),
        headline     TEXT NOT NULL,
        sections     TEXT NOT NULL,
        generated_at TEXT NOT NULL,
        model        TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS view_scoped_profile (
        scope_key    TEXT PRIMARY KEY,
        headline     TEXT NOT NULL,
        sections     TEXT NOT NULL,
        generated_at TEXT NOT NULL,
        model        TEXT NOT NULL
      );
      -- Full-text index over what is searchable. Derived state like the other
      -- views: dropped and re-derived on a schema bump, rebuilt with them.
      -- porter stemming means "tests" finds "testing"; prefix queries mean
      -- "postgres" finds "PostgreSQL". primary/secondary are separate columns
      -- so bm25 can weight a name above the entities beside it.
      CREATE VIRTUAL TABLE IF NOT EXISTS view_search USING fts5(
        primary_text,
        secondary_text,
        kind UNINDEXED,
        ref UNINDEXED,
        category UNINDEXED,
        strength UNINDEXED,
        tokenize='porter unicode61'
      );
    `);
    // ver 0 is either a fresh db or a pre-versioning one — rebuild whenever events already exist.
    if (ver < VIEW_SCHEMA_VERSION) {
      const n = (this.db.prepare("SELECT COUNT(*) n FROM events").get() as { n: number }).n;
      if (n > 0) this.rebuild();
    }
  }

  append(events: PersnallyEvent[]): number {
    const insert = this.db.prepare(
      `INSERT INTO events (id, ts, recorded_at, source, type, payload, provenance, schema_ver)
       VALUES (@id, @ts, @recorded_at, @source, @type, @payload, @provenance, @schema_ver)`,
    );
    const run = this.db.transaction((batch: PersnallyEvent[]) => {
      for (const raw of batch) {
        const e = validateEvent(raw);
        insert.run({
          ...e,
          payload: JSON.stringify(e.payload),
          provenance: JSON.stringify(e.provenance),
        });
      }
    });
    run(events);
    return events.length;
  }

  query(opts: QueryOpts = {}): PersnallyEvent[] {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (opts.type) { where.push("type = @type"); params.type = opts.type; }
    if (opts.source) { where.push("source = @source"); params.source = opts.source; }
    if (opts.since) { where.push("ts >= @since"); params.since = opts.since; }
    if (opts.recordedSince) { where.push("recorded_at >= @recordedSince"); params.recordedSince = opts.recordedSince; }
    const sql = `SELECT * FROM events ${where.length ? "WHERE " + where.join(" AND ") : ""}
                 ORDER BY ts DESC LIMIT @limit`;
    params.limit = opts.limit ?? 100;
    return this.db.prepare(sql).all(params).map(rowToEvent);
  }

  getEvents(ids: string[]): PersnallyEvent[] {
    if (!ids.length) return [];
    // One bind parameter per id, so an unbounded list would hit
    // SQLITE_MAX_VARIABLE_NUMBER. Provenance walks ask for a handful.
    const wanted = ids.slice(0, MAX_ID_LOOKUP);
    const placeholders = wanted.map(() => "?").join(",");
    return this.db
      .prepare(`SELECT * FROM events WHERE id IN (${placeholders})`)
      .all(...wanted)
      .map(rowToEvent);
  }

  /**
   * Reads one JSON field out of a type or source's events without materializing
   * the events themselves — the derived reads only ever want a field or two, and
   * rowToEvent costs two JSON.parse per row.
   */
  private pluck(column: "payload" | "provenance", field: string, where: { type?: string; source?: string }): string[] {
    const clause = where.type ? "type = @type" : "source = @source";
    return this.db
      .prepare(`SELECT DISTINCT json_extract(${column}, '$.${field}') v FROM events
                WHERE ${clause} AND v IS NOT NULL`)
      .all(where)
      .map((r) => (r as { v: string }).v);
  }

  /** Payload-only rows for a type, newest first. Skips parsing provenance, which the derived reads don't use. */
  private payloads<T>(type: string, limit = -1): Array<{ id: string; ts: string; payload: T }> {
    return this.db
      .prepare(`SELECT id, ts, payload FROM events WHERE type = ? ORDER BY ts DESC LIMIT ?`)
      .all(type, limit)
      .map((r) => {
        const row = r as { id: string; ts: string; payload: string };
        return { id: row.id, ts: row.ts, payload: JSON.parse(row.payload) as T };
      });
  }

  /** conversation_uuids already imported from a source — lets a re-import top up only new chats, never double. */
  importedConversationUuids(source: string): Set<string> {
    return new Set(this.pluck("provenance", "conversation_uuid", { source }));
  }

  /** repo names already imported via `import git` — lets a re-import skip repos already on file. */
  importedGitRepos(): Set<string> {
    return new Set(this.pluck("provenance", "repo", { source: "import:git" }));
  }

  stats(): { total: number; byType: Record<string, number>; bySource: Record<string, number>; first: string | null; last: string | null } {
    const total = (this.db.prepare("SELECT COUNT(*) n FROM events").get() as { n: number }).n;
    const group = (col: string) =>
      Object.fromEntries(
        (this.db.prepare(`SELECT ${col} k, COUNT(*) n FROM events GROUP BY ${col}`).all() as { k: string; n: number }[])
          .map((r) => [r.k, r.n]),
      );
    const span = this.db.prepare("SELECT MIN(ts) first, MAX(ts) last FROM events").get() as { first: string | null; last: string | null };
    return { total, byType: group("type"), bySource: group("source"), ...span };
  }

  /**
   * Engagement over time from context.read events — the retention pulse.
   * Local/per-install only (this machine); aggregate cohort retention would
   * require opt-in telemetry. `now` is injectable for deterministic tests.
   */
  activity(now: number = Date.now()): Activity {
    const DAY = 86_400_000;
    const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);

    // context.read is the fastest-growing type and this runs on a dashboard
    // poll, so the totals come from the index and only the windows that feed
    // the buckets are read back. The date math stays in JS: SQLite's second
    // resolution would drift against a ms boundary.
    const totals = this.db
      .prepare("SELECT COUNT(*) n, MIN(ts) first, MAX(ts) last FROM events WHERE type = 'context.read'")
      .get() as { n: number; first: string | null; last: string | null };
    const firstEventAt = (this.db.prepare("SELECT MIN(ts) m FROM events").get() as { m: string | null }).m;
    const firstMs = firstEventAt ? new Date(firstEventAt).getTime() : null;
    // Retention is anchored to when serving actually began (the first read), not
    // onboarding — so a gap between setup and the first read can't read as a
    // false "not retained". For a fresh install the two are minutes apart.
    const firstReadAt = totals.first;
    const firstReadMs = firstReadAt ? new Date(firstReadAt).getTime() : null;

    const daily = new Map<string, number>();
    for (let i = 13; i >= 0; i--) daily.set(dayKey(now - i * DAY), 0);

    let reads7d = 0, reads30d = 0;
    const days7 = new Set<string>(), days14 = new Set<string>();
    for (const ts of this.readTimestampsAround(now - 30 * DAY, now)) {
      const t = new Date(ts).getTime();
      if (!Number.isFinite(t)) continue;
      const age = now - t, k = dayKey(t);
      if (age <= 7 * DAY) { reads7d++; days7.add(k); }
      if (age <= 14 * DAY) days14.add(k);
      if (age <= 30 * DAY) reads30d++;
      if (daily.has(k)) daily.set(k, (daily.get(k) ?? 0) + 1);
    }

    // Week 2 sits outside the 30-day window on an older install, so ask for
    // exactly that stretch instead of widening the scan above.
    let week2Read = false;
    if (firstReadMs !== null) {
      for (const ts of this.readTimestampsAround(firstReadMs + 7 * DAY, firstReadMs + 14 * DAY)) {
        const t = new Date(ts).getTime();
        if (t >= firstReadMs + 7 * DAY && t < firstReadMs + 14 * DAY) { week2Read = true; break; }
      }
    }

    return {
      firstEventAt,
      firstReadAt,
      lastReadAt: totals.last,
      daysSinceFirst: firstMs !== null ? Math.max(0, Math.floor((now - firstMs) / DAY)) : 0,
      daysSinceFirstRead: firstReadMs !== null ? Math.max(0, Math.floor((now - firstReadMs) / DAY)) : 0,
      totalReads: totals.n,
      reads7d,
      reads30d,
      activeDays7d: days7.size,
      activeDays14d: days14.size,
      retainedWeek2: firstReadMs !== null && now >= firstReadMs + 14 * DAY ? week2Read : null,
      daily: [...daily.entries()].map(([date, r]) => ({ date, reads: r })),
    };
  }

  /**
   * context.read timestamps around a window, as an over-selection the caller
   * filters exactly.
   *
   * The bounds are plain string comparisons so idx_events_type(type, ts) does
   * the work — a function on the column (strftime) would force a scan. A stored
   * UTC offset can put the string up to 14h ahead of, or 12h behind, the instant
   * it denotes, so the range is padded a full day on each side: it can only ever
   * return too much, never too little.
   */
  private readTimestampsAround(fromMs: number, toMs: number): string[] {
    const DAY = 86_400_000;
    return this.db
      .prepare(`SELECT ts FROM events
                WHERE type = 'context.read' AND ts >= @from AND ts < @to
                ORDER BY ts DESC`)
      .all({ from: new Date(fromMs - DAY).toISOString(), to: new Date(toMs + DAY).toISOString() })
      .map((r) => (r as { ts: string }).ts);
  }

  /** Corrections the user stated (action edit/contradict — deletes are
      tombstones, not statements). Newest first; the authoritative layer that
      ask and profile synthesis must weight above derived signals. */
  corrections(limit = 50): { id: string; ts: string; subject: string; correction: string }[] {
    // Filtered and limited in SQL: this runs on every ask and every synthesis,
    // and corrections accrue for the life of the install.
    return this.db
      .prepare(`SELECT id, ts,
                       json_extract(payload, '$.target_id') subject,
                       json_extract(payload, '$.reason')    correction
                FROM events
                WHERE type = 'user.correction'
                  AND json_extract(payload, '$.action') != 'delete'
                  AND trim(COALESCE(json_extract(payload, '$.reason'), '')) != ''
                ORDER BY ts DESC LIMIT ?`)
      .all(limit) as { id: string; ts: string; subject: string; correction: string }[];
  }

  /** agent.question/agent.answer exchanges joined with the user's feedback —
      the precision surface of the ask_user_model loop. */
  askHistory(limit = 50): { items: AskRow[]; stats: AskStats } {
    // The stats are counts over every answer, so they are counted in SQL. Only
    // the rows actually rendered are read back, and only the questions those
    // rows cite — this used to pull three whole event types into memory.
    const counts = this.db
      .prepare(`SELECT COUNT(*) asked,
                       SUM(CASE WHEN json_extract(payload, '$.deferred') IN (1, 'true') THEN 1 ELSE 0 END) deferred
                FROM events WHERE type = 'agent.answer'`)
      .get() as { asked: number; deferred: number | null };

    // Latest verdict per answer, resolved in one descending pass. A correlated
    // "max ts per subject" subquery reads far worse here: json_extract can't use
    // an index, so it degrades to a scan per feedback row.
    const answerIds = new Set(
      (this.db.prepare("SELECT id FROM events WHERE type = 'agent.answer'").all() as { id: string }[])
        .map((r) => r.id),
    );
    const verdicts = new Map<string, AskRow["verdict"]>();
    for (const r of this.db
      .prepare(`SELECT json_extract(payload, '$.subject_id') subject,
                       json_extract(payload, '$.verdict')    verdict
                FROM events WHERE type = 'feedback.signal' ORDER BY ts DESC`)
      .all() as { subject: string; verdict: AskRow["verdict"] }[]) {
      // First seen wins (ts DESC = newest), and only if its answer still
      // exists — a deleted answer must not leave a vote in the precision stat.
      if (!verdicts.has(r.subject) && answerIds.has(r.subject)) verdicts.set(r.subject, r.verdict);
    }

    const stats: AskStats = {
      asked: counts.asked,
      answered: counts.asked - (counts.deferred ?? 0),
      deferred: counts.deferred ?? 0,
      approved: 0, edited: 0, vetoed: 0, precision: null,
    };
    // Count each judged answer once, under its latest verdict only.
    for (const v of verdicts.values()) {
      if (v === "approved") stats.approved++;
      else if (v === "edited") stats.edited++;
      else if (v === "vetoed") stats.vetoed++;
    }
    const labeled = stats.approved + stats.edited + stats.vetoed;
    if (labeled) stats.precision = stats.approved / labeled;

    const recent = this.payloads<{
      question_id: string;
      answer: string;
      confidence: number;
      deferred: boolean;
      evidence_event_ids?: string[];
    }>("agent.answer", limit);
    const questions = new Map(
      this.getEvents([...new Set(recent.map((a) => a.payload.question_id).filter(Boolean))]).map((e) => [e.id, e]),
    );
    const items = recent.map((a): AskRow => {
      const p = a.payload;
      const qp = questions.get(p.question_id)?.payload as { question?: string; asker?: string } | undefined;
      return {
        question_id: p.question_id,
        answer_id: a.id,
        ts: a.ts,
        asker: qp?.asker ?? "",
        question: qp?.question ?? "",
        answer: p.answer,
        confidence: p.confidence,
        deferred: p.deferred,
        evidence_event_ids: p.evidence_event_ids ?? [],
        verdict: verdicts.get(a.id) ?? null,
      };
    });
    return { items, stats };
  }

  /** A topic's category, or null if it isn't in the graph — lets the daemon hold
      a destructive request to the same categories the client is allowed to read. */
  topicCategory(topic: string): string | null {
    const key = normalizeTopic(topic);
    if (!key) return null;
    const row = this.db.prepare("SELECT category FROM view_topics WHERE topic_key = ?").get(key) as { category: string } | undefined;
    return row?.category ?? null;
  }

  topics(limit = 50): TopicRow[] {
    const rows = this.db
      .prepare("SELECT * FROM view_topics ORDER BY weight DESC LIMIT ?")
      .all(limit) as Array<Omit<TopicRow, "entities" | "event_ids"> & { entities: string; event_ids: string }>;
    return rows.map((r) => ({ ...r, entities: JSON.parse(r.entities), event_ids: JSON.parse(r.event_ids) }));
  }

  /** Re-derive view_topics from signal.topic events using decayed per-signal weighting. */
  rebuild(now: number = Date.now()): void {
    this.db.exec("DELETE FROM view_topics");

    interface Acc { topic: string; categories: Map<string, number>; signals: WeightSignal[]; entities: Set<string>; first: string; last: string; ids: string[]; merged: string[] }
    const acc = new Map<string, Acc>();
    // Decay is per-signal and time-dependent, so every topic signal is genuinely
    // needed here — but provenance isn't, and this runs on every tracked write.
    for (const e of this.payloads<{ topic: string; weight: number; category: string; depth: string; sentiment: string; intent: string; entities: string[] }>("signal.topic")) {
      const p = e.payload;
      const key = normalizeTopic(p.topic);
      if (!key) continue;
      let a = acc.get(key);
      if (!a) {
        a = { topic: p.topic, categories: new Map(), signals: [], entities: new Set(), first: e.ts, last: e.ts, ids: [], merged: [] };
        acc.set(key, a);
      }
      a.categories.set(p.category, (a.categories.get(p.category) ?? 0) + 1);
      a.signals.push({ ts: e.ts, weight: p.weight, depth: p.depth, sentiment: p.sentiment, intent: p.intent });
      for (const ent of p.entities) a.entities.add(ent);
      if (e.ts < a.first) a.first = e.ts;
      if (e.ts > a.last) a.last = e.ts;
      a.ids.push(e.id);
    }

    // Decay rate depends on the category, so resolve it before weighting.
    const overrides = decayOverrides();
    const categoryOf = (a: Acc) => [...a.categories.entries()].sort((x, y) => y[1] - x[1])[0]![0];

    // Extraction renames the same interest every time it sees it, which splits
    // one topic into several weaker ones. Fold near-duplicates into the heaviest
    // phrasing — in the view only, so every constituent event keeps its own
    // provenance and a changed threshold just re-derives.
    // The ranking pass is reused, so merging doesn't weigh every topic twice —
    // only rows that absorbed a variant are recomputed. (Measured: merging costs
    // ~2.4ms of a 41ms rebuild on a 1,886-topic store; grouping is 1.6ms of it.)
    const weighed = new Map<string, ReturnType<typeof topicWeight>>();
    const ranking = [...acc.entries()].map(([key, a]) => {
      const category = categoryOf(a);
      const w = topicWeight(a.signals, now, category, overrides);
      weighed.set(key, w);
      return { key, category, weight: w.weight };
    });
    const canonicalOf = groupNearDuplicates(ranking, TOPIC_MERGE_THRESHOLD);
    for (const [variant, canonical] of canonicalOf) {
      const from = acc.get(variant);
      const into = acc.get(canonical);
      if (!from || !into) continue;
      into.signals.push(...from.signals);
      for (const ent of from.entities) into.entities.add(ent);
      into.ids.push(...from.ids);
      for (const [cat, n] of from.categories) into.categories.set(cat, (into.categories.get(cat) ?? 0) + n);
      if (from.first < into.first) into.first = from.first;
      if (from.last > into.last) into.last = from.last;
      into.merged.push(from.topic);
      acc.delete(variant);
    }

    const rows: TopicRow[] = [...acc.entries()].map(([key, a]) => {
      const category = categoryOf(a);
      const w = a.merged.length > 0 ? topicWeight(a.signals, now, category, overrides) : weighed.get(key)!;
      return {
        topic_key: key,
        topic: a.topic,
        category,
        signals: a.signals.length,
        // Guard the NOT NULL column: a non-finite weight would abort the whole
        // rebuild transaction and wedge the topic view permanently.
        weight: Number.isFinite(w.weight) ? w.weight : 0,
        sentiment_balance: w.sentiment_balance,
        dominant_intent: w.dominant_intent,
        entities: [...a.entities].slice(0, 20),
        first_seen: a.first,
        last_seen: a.last,
        event_ids: a.ids,
      };
    });

    // Folded phrasings stay searchable as secondary text: the display collapses
    // to one label, but a phrase the user remembers must still find its row.
    const mergedByKey = new Map<string, string[]>([...acc].map(([k, a]) => [k, a.merged]));
    this.reindexSearch(rows, mergedByKey);
    const insert = this.db.prepare(
      `INSERT INTO view_topics VALUES (@topic_key, @topic, @category, @signals, @weight,
        @sentiment_balance, @dominant_intent, @entities, @first_seen, @last_seen, @event_ids)`,
    );
    const run = this.db.transaction((batch: TopicRow[]) => {
      for (const r of batch) {
        insert.run({ ...r, entities: JSON.stringify(r.entities), event_ids: JSON.stringify(r.event_ids) });
      }
    });
    run(rows);
  }

  saveProfile(p: StoredProfile): void {
    this.db.prepare(
      `INSERT INTO view_profile (id, headline, sections, generated_at, model)
       VALUES (1, @headline, @sections, @generated_at, @model)
       ON CONFLICT(id) DO UPDATE SET headline=@headline, sections=@sections, generated_at=@generated_at, model=@model`,
    ).run({ ...p, sections: JSON.stringify(p.sections) });
  }

  getProfile(): StoredProfile | null {
    const row = this.db.prepare("SELECT * FROM view_profile WHERE id = 1").get() as
      | { headline: string; sections: string; generated_at: string; model: string }
      | undefined;
    return row ? { ...row, sections: JSON.parse(row.sections) } : null;
  }

  // Scoped profiles: one cached synthesis per distinct category set, so a
  // scoped client gets a narrative built only from what it may read.
  saveScopedProfile(scopeKey: string, p: StoredProfile): void {
    this.db.prepare(
      `INSERT INTO view_scoped_profile (scope_key, headline, sections, generated_at, model)
       VALUES (@scope_key, @headline, @sections, @generated_at, @model)
       ON CONFLICT(scope_key) DO UPDATE SET headline=@headline, sections=@sections, generated_at=@generated_at, model=@model`,
    ).run({ ...p, scope_key: scopeKey, sections: JSON.stringify(p.sections) });
  }

  getScopedProfile(scopeKey: string): StoredProfile | null {
    const row = this.db.prepare("SELECT * FROM view_scoped_profile WHERE scope_key = ?").get(scopeKey) as
      | { headline: string; sections: string; generated_at: string; model: string }
      | undefined;
    return row ? { headline: row.headline, sections: JSON.parse(row.sections), generated_at: row.generated_at, model: row.model } : null;
  }

  scopedProfileKeys(): string[] {
    return (this.db.prepare("SELECT scope_key FROM view_scoped_profile").all() as { scope_key: string }[])
      .map((r) => r.scope_key);
  }

  deleteScopedProfile(scopeKey: string): void {
    this.db.prepare("DELETE FROM view_scoped_profile WHERE scope_key = ?").run(scopeKey);
  }

  /** Logical key for one style pattern — stable across re-imports/re-observations. */
  private styleKey(dimension: string, pattern: string): string {
    return `style:${dimension}|${pattern.toLowerCase()}`;
  }

  /** Patterns the user has explicitly forgotten — a delete correction tombstones the key permanently. */
  private forgottenStyleKeys(): Set<string> {
    return new Set(
      this.db
        .prepare(`SELECT DISTINCT json_extract(payload, '$.target_id') k FROM events
                  WHERE type = 'user.correction'
                    AND json_extract(payload, '$.action') = 'delete'
                    AND k LIKE 'style:%'`)
        .all()
        .map((r) => (r as { k: string }).k),
    );
  }

  /** The voice/convention profile — style signals deduped by pattern (newest wins), richest first, forgotten patterns excluded. */
  /**
   * Re-derives the full-text index from the topics just computed plus every
   * assertion. Runs inside rebuild() so the index can never drift from the
   * views it searches — the same reason view_topics is re-derived rather than
   * incrementally patched.
   */
  private reindexSearch(topics: TopicRow[], mergedByKey: Map<string, string[]> = new Map()): void {
    const insert = this.db.prepare(
      "INSERT INTO view_search (primary_text, secondary_text, kind, ref, category, strength) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const run = this.db.transaction(() => {
      this.db.exec("DELETE FROM view_search");
      for (const t of topics) {
        const secondary = [t.entities.join(" "), ...(mergedByKey.get(t.topic_key) ?? [])].join(" ");
        insert.run(t.topic, secondary, "topic", t.topic_key, t.category, t.weight);
      }
      for (const e of this.payloads<{ claim: string; confidence: number; evidence: string }>("signal.assertion")) {
        insert.run(e.payload.claim, e.payload.evidence ?? "", "assertion", e.id, "", e.payload.confidence ?? 0.5);
      }
    });
    run();
  }

  /**
   * Ranked full-text lookup. bm25 supplies IDF for free — a hit on a rare
   * project name outranks one on a common word — which literal substring
   * matching could never do. Returns refs; the caller resolves them so the
   * views stay the single source of truth for rendering.
   */
  searchIndex(
    matchExpr: string,
    opts: { limit?: number; allowed?: string[] | null; includeAssertions?: boolean } = {},
  ): { kind: string; ref: string; score: number; strength: number }[] {
    if (!matchExpr) return [];
    const where = ["view_search MATCH ?"];
    const params: unknown[] = [matchExpr];
    if (!opts.includeAssertions) where.push("kind = 'topic'");
    if (opts.allowed?.length) {
      where.push(`(kind = 'assertion' OR category IN (${opts.allowed.map(() => "?").join(",")}))`);
      params.push(...opts.allowed);
    }
    params.push(opts.limit ?? 10);
    try {
      // bm25 is negative, more negative = better; flip it so callers sort desc.
      return (this.db.prepare(
        `SELECT kind, ref, strength, -bm25(view_search, 3.0, 1.0) score
         FROM view_search WHERE ${where.join(" AND ")}
         ORDER BY score DESC LIMIT ?`,
      ).all(...params) as { kind: string; ref: string; score: number; strength: number }[]);
    } catch {
      // A malformed MATCH expression is a bad query, not a broken store —
      // return nothing rather than taking down the caller.
      return [];
    }
  }

  /** One topic row by its normalized key, for resolving a search hit. */
  topicByKey(key: string): TopicRow | null {
    const r = this.db.prepare("SELECT * FROM view_topics WHERE topic_key = ?").get(key) as
      (Omit<TopicRow, "entities" | "event_ids"> & { entities: string; event_ids: string }) | undefined;
    return r ? { ...r, entities: JSON.parse(r.entities) as string[], event_ids: JSON.parse(r.event_ids) as string[] } : null;
  }

  /**
   * Demonstrated skills, aggregated across repos. `signal.skill` had no reader
   * anywhere — the git importer's entire skill output (frameworks, and now
   * languages by file count) was written and never surfaced, so the one
   * key-free import path contributed nothing to the profile or to context.
   * Proficiency takes the strongest observation; `sources` says how many repos
   * back it, which is what separates a language someone uses from one they
   * touched once.
   */
  skills(limit = 25): { skill: string; domain: string; proficiency: number; sources: number }[] {
    interface Acc { skill: string; domain: string; proficiency: number; sources: Set<string> }
    const acc = new Map<string, Acc>();
    for (const e of this.payloads<{ skill: string; domain: string; proficiency: number; basis: string }>("signal.skill")) {
      const p = e.payload;
      const key = p.skill.toLowerCase().trim();
      if (!key) continue;
      const cur = acc.get(key) ?? { skill: p.skill, domain: p.domain, proficiency: 0, sources: new Set<string>() };
      cur.proficiency = Math.max(cur.proficiency, Number.isFinite(p.proficiency) ? p.proficiency : 0);
      if (p.domain) cur.domain = p.domain;
      // `basis` carries the repo it came from (repo-activity:x / files-touched:x).
      cur.sources.add(p.basis || "unknown");
      acc.set(key, cur);
    }
    return [...acc.values()]
      .map((a) => ({ skill: a.skill, domain: a.domain, proficiency: a.proficiency, sources: a.sources.size }))
      .sort((a, b) => b.proficiency - a.proficiency || b.sources - a.sources)
      .slice(0, limit);
  }

  /**
   * The served voice pack. `project` scopes it: unscoped signals always apply,
   * a project's own signals apply when you are in it, and another project's
   * never do. Without that filter the pack could assert both "prefers pnpm over
   * npm" and the reverse — each true of one repo, neither true of the person.
   */
  voice(project?: string): { pack: string; items: StyleSignal[] } {
    const forgotten = this.forgottenStyleKeys();
    const byPattern = new Map<string, StyleSignal>();
    const rows = this.db
      .prepare(`SELECT payload, json_extract(provenance, '$.project') AS project
                FROM events WHERE type = 'signal.style' ORDER BY ts DESC`)
      .all() as { payload: string; project: string | null }[];
    // Newest first, so the first occurrence of a pattern is the most recent.
    for (const row of rows) {
      const p = JSON.parse(row.payload) as StyleSignal;
      if (row.project && row.project !== project) continue;
      // An `emphasis` signal from stylometry can only have come from the phrase
      // miner that was removed for emitting subject matter as preference. The
      // events stay on file and stay deletable — they just stop being served to
      // clients as instructions.
      if (p.dimension === "emphasis" && p.basis === "stylometry") continue;
      const key = this.styleKey(p.dimension, p.pattern);
      if (forgotten.has(key) || byPattern.has(key)) continue;
      byPattern.set(key, p);
    }
    // Cap the served set: live `observed` signals accrue over time, so bound it
    // to the richest few (consolidation prunes the stored backlog separately).
    const items = [...byPattern.values()].sort((a, b) => b.confidence - a.confidence).slice(0, 28);
    return { pack: assemblePack(items), items };
  }

  /**
   * Every project-scoped style signal, grouped by project. The served pack hides
   * other projects' conventions by design, which would otherwise make them
   * invisible — and so undeletable — from the owner's own surface.
   */
  scopedVoice(): { project: string; items: StyleSignal[] }[] {
    const forgotten = this.forgottenStyleKeys();
    const byProject = new Map<string, Map<string, StyleSignal>>();
    const rows = this.db
      .prepare(`SELECT payload, json_extract(provenance, '$.project') AS project
                FROM events
                WHERE type = 'signal.style' AND json_extract(provenance, '$.project') IS NOT NULL
                ORDER BY ts DESC`)
      .all() as { payload: string; project: string }[];
    for (const row of rows) {
      const p = JSON.parse(row.payload) as StyleSignal;
      const key = this.styleKey(p.dimension, p.pattern);
      if (forgotten.has(key)) continue;
      const seen = byProject.get(row.project) ?? new Map<string, StyleSignal>();
      if (!seen.has(key)) seen.set(key, p);
      byProject.set(row.project, seen);
    }
    return [...byProject].map(([project, items]) => ({ project, items: [...items.values()] }))
      .sort((a, b) => b.items.length - a.items.length);
  }

  /**
   * Hard-deletes a style pattern's events and writes a delete correction so it
   * stays gone even if stylometry or live capture re-derives it later — the
   * "deletable for real" promise extended to the voice layer.
   */
  forgetStyle(dimension: string, pattern: string): number {
    const key = this.styleKey(dimension, pattern);
    // Matched in SQL on the same lowercased key the styleKey() helper builds.
    const deleted = this.db
      .prepare(`DELETE FROM events
                WHERE type = 'signal.style'
                  AND 'style:' || json_extract(payload, '$.dimension') || '|'
                      || lower(json_extract(payload, '$.pattern')) = ?`)
      .run(key).changes;
    this.append([newEvent("user.correction", "dashboard", { target_id: key, action: "delete", reason: "" }, { kind: "local", surface: "dashboard" })]);
    this.reclaim();
    return deleted;
  }

  /** Drops style signals of one basis so a deterministic re-run replaces them (live `observed`/`correction` signals are kept). */
  clearStyleByBasis(basis: string, sources?: string[]): number {
    // `sources` narrows the wipe to signals a caller can actually re-derive.
    // refreshVoice re-reads only the Claude Code transcripts still on disk —
    // deleting stylometry from claude.ai/ChatGPT exports (long gone from disk)
    // destroyed voice that could never be rebuilt.
    if (!sources?.length) {
      return this.db
        .prepare("DELETE FROM events WHERE type = 'signal.style' AND json_extract(payload, '$.basis') = ?")
        .run(basis).changes;
    }
    const marks = sources.map(() => "?").join(",");
    return this.db
      .prepare(`DELETE FROM events WHERE type = 'signal.style'
                AND json_extract(payload, '$.basis') = ? AND source IN (${marks})`)
      .run(basis, ...sources).changes;
  }

  /**
   * Per-conversation import watermark: the `message_uuid` recorded by the most
   * recent import of each conversation. Lets the incremental importer top up a
   * resumed session with only the messages after the last one it consumed.
   */
  conversationWatermarks(source: string): Map<string, string> {
    const rows = this.db.prepare(
      `SELECT json_extract(provenance, '$.conversation_uuid') cu,
              json_extract(provenance, '$.message_uuid') mu
       FROM events
       WHERE source = ?
         AND json_extract(provenance, '$.conversation_uuid') IS NOT NULL
         AND json_extract(provenance, '$.message_uuid') IS NOT NULL
       ORDER BY recorded_at ASC`,
    ).all(source) as { cu: string; mu: string }[];
    const marks = new Map<string, string>();
    for (const r of rows) marks.set(r.cu, r.mu); // ascending order → the last write per conversation wins
    return marks;
  }

  /**
   * Consolidation distill: bounds the stored style backlog so live capture
   * never grows unbounded. Keeps the richest signal per pattern, capped overall.
   */
  pruneStyle(maxTotal = 80): number {
    const all = this.payloads<StyleSignal>("signal.style");
    const byPattern = new Map<string, { id: string; confidence: number }>();
    for (const e of all) {
      const key = this.styleKey(e.payload.dimension, e.payload.pattern);
      const existing = byPattern.get(key);
      if (!existing || existing.confidence < e.payload.confidence) {
        byPattern.set(key, { id: e.id, confidence: e.payload.confidence });
      }
    }
    const keepIds = new Set(
      [...byPattern.values()].sort((a, b) => b.confidence - a.confidence).slice(0, maxTotal).map((s) => s.id),
    );
    const toDelete = all.filter((e) => !keepIds.has(e.id)).map((e) => e.id); // drop weaker duplicates + overflow
    const del = this.db.prepare("DELETE FROM events WHERE id = ?");
    const run = this.db.transaction((ids: string[]) => { for (const id of ids) del.run(id); });
    run(toDelete);
    return toDelete.length;
  }

  /** Hard-deletes matching topic events plus derived events referencing them, then rebuilds. */
  /**
   * Every event behind the row that displays this topic. Falls back to payload
   * matching when the key names an absorbed phrasing rather than the canonical
   * one, then widens to the row that owns those events.
   */
  private topicEventIds(key: string): Set<string> {
    // The view is derived and append() does not rebuild it, so an event written
    // since the last rebuild is absent from event_ids. Trusting the row alone
    // would delete part of a topic, rebuild, and let the survivor re-create the
    // row — reporting a count while the topic stayed on screen.
    const own = new Set(
      this.payloads<{ topic: string }>("signal.topic")
        .filter((e) => normalizeTopic(e.payload.topic) === key)
        .map((e) => e.id),
    );

    const direct = this.db.prepare("SELECT event_ids FROM view_topics WHERE topic_key = ?").get(key) as
      | { event_ids: string } | undefined;
    if (direct) {
      for (const id of JSON.parse(direct.event_ids) as string[]) own.add(id);
      return own;
    }
    if (own.size === 0) return own;
    // The key names a phrasing that merged into another row: take that row too,
    // so forgetting what is displayed removes all of it.
    for (const row of this.db.prepare("SELECT event_ids FROM view_topics").all() as { event_ids: string }[]) {
      const rowIds = JSON.parse(row.event_ids) as string[];
      if (rowIds.some((id) => own.has(id))) {
        for (const id of rowIds) own.add(id);
        break;
      }
    }
    return own;
  }

  forgetTopic(topic: string): number {
    const key = normalizeTopic(topic);
    // Rows are merged, so what the user sees as one interest can span several
    // phrasings. Delete the whole row they were looking at — a partial delete
    // would leave the topic on screen after reporting it forgotten.
    const ids = this.topicEventIds(key);
    this.addDerivedDescendants(ids);
    const del = this.db.prepare("DELETE FROM events WHERE id = ?");
    const run = this.db.transaction((toDelete: string[]) => {
      for (const id of toDelete) del.run(id);
    });
    run([...ids]);
    this.rebuild();
    this.reclaim();
    return ids.size;
  }

  /**
   * Grows `ids` to include every derived event whose `from` chain reaches one
   * of them. Derived events are the only kind that can reference another, and a
   * derived event can itself be derived from (a nightly assertion built on an
   * earlier one), so this walks to a fixpoint — one pass would leave
   * grandchildren behind, and which ones would depend on row order.
   * EVENT_SCHEMA.md promises the whole chain goes.
   */
  private addDerivedDescendants(ids: Set<string>): void {
    const derived = (this.db
      .prepare(`SELECT id, json_extract(provenance, '$.from') f FROM events
                WHERE json_extract(provenance, '$.kind') = 'derived'`)
      .all() as { id: string; f: string | null }[])
      .map((r) => ({ id: r.id, from: r.f ? (JSON.parse(r.f) as string[]) : [] }));
    for (let grew = true; grew; ) {
      grew = false;
      for (const d of derived) {
        if (!ids.has(d.id) && d.from.some((id) => ids.has(id))) {
          ids.add(d.id);
          grew = true;
        }
      }
    }
  }

  /**
   * Drops everything a set of conversations produced, so they can be extracted
   * again from the source. Used by `import --reextract`: without it a re-run
   * would double every signal instead of replacing it.
   */
  forgetConversations(source: string, uuids: Set<string>): number {
    if (!uuids.size) return 0;
    const ids = new Set(
      (this.db.prepare(
        `SELECT id, json_extract(provenance, '$.conversation_uuid') cu
         FROM events WHERE source = ?`,
      ).all(source) as { id: string; cu: string | null }[])
        .filter((r) => r.cu !== null && uuids.has(r.cu))
        .map((r) => r.id),
    );
    this.addDerivedDescendants(ids);
    const del = this.db.prepare("DELETE FROM events WHERE id = ?");
    this.db.transaction((toDelete: string[]) => { for (const id of toDelete) del.run(id); })([...ids]);
    this.reclaim();
    return ids.size;
  }

  /**
   * Extractor version per import batch for one source, newest batch first.
   * A batch imported before versioning existed reports null — it predates the
   * current pipeline by definition, so it is always a re-extraction candidate.
   */
  importBatchVersions(source: string): { batch: string; version: number | null; events: number; at: string }[] {
    return (this.db.prepare(
      `SELECT json_extract(payload, '$.batch') batch,
              json_extract(payload, '$.extractor_version') version,
              json_extract(payload, '$.events') events,
              recorded_at at
       FROM events
       WHERE type = 'system.import' AND json_extract(provenance, '$.file') IS NOT NULL
         AND json_extract(payload, '$.importer') = ?
       ORDER BY recorded_at DESC`,
    ).all(source) as { batch: string; version: number | null; events: number; at: string }[]);
  }

  /** Removes every event from one import batch — a bad import is fully reversible. */
  forgetBatch(batch: string): number {
    const result = this.db
      .prepare("DELETE FROM events WHERE json_extract(provenance, '$.batch') = ?")
      .run(batch);
    this.rebuild();
    this.reclaim();
    return result.changes;
  }

  forgetAll(): void {
    // Every derived table, including the full-text index — it stores the topic
    // and claim text verbatim, so leaving it would keep "deleted" content
    // readable in the database file (the residue guarantee in deletion.test.ts
    // catches exactly this).
    this.db.exec(
      "DELETE FROM events; DELETE FROM view_topics; DELETE FROM view_profile;"
      + " DELETE FROM view_scoped_profile; DELETE FROM view_search;",
    );
    this.reclaim();
    // Only on the full wipe: rebuilds the file so even pages freed before
    // secure_delete was enabled (an install that upgraded into it) are gone.
    // Cheap here precisely because everything was just deleted.
    this.db.exec("VACUUM");
  }

  /**
   * Freed pages are zeroed by `secure_delete`, but in WAL mode the pre-delete
   * copy lives on in `-wal` until a checkpoint. Truncating it is what makes
   * "deleted" true on disk rather than only inside a transaction.
   */
  private reclaim(): void {
    this.db.pragma("wal_checkpoint(TRUNCATE)");
  }

  close(): void {
    this.db.close();
  }
}

function rowToEvent(row: unknown): PersnallyEvent {
  const r = row as Record<string, string | number>;
  return {
    ...r,
    payload: JSON.parse(r.payload as string),
    provenance: JSON.parse(r.provenance as string),
  } as PersnallyEvent;
}
