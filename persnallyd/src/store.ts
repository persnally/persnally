/**
 * EventStore — append-only SQLite event log plus rebuildable derived views.
 * Single source of truth per docs/EVENT_SCHEMA.md; views can always be re-derived.
 */

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { topicWeight, type WeightSignal } from "./decay.js";
import { newEvent, normalizeTopic, validateEvent, type PersnallyEvent } from "./events.js";
import { DATA_DIR } from "./paths.js";
import { assemblePack, type StyleSignal } from "./stylometry.js";

const VIEW_SCHEMA_VERSION = 2;

export const DEFAULT_DB_PATH = join(DATA_DIR, "persnally.db");

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
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    // The CLI and the daemon each open their own connection; a blocked writer
    // waits instead of failing fast with SQLITE_BUSY (better-sqlite3 defaults
    // to 5s — set explicitly with headroom for large rebuilds).
    this.db.pragma("busy_timeout = 10000");
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
    `);
    // Views are derived state: on schema change, drop and re-derive rather than ALTER.
    const ver = (this.db.pragma("user_version", { simple: true }) as number) ?? 0;
    if (ver < VIEW_SCHEMA_VERSION) {
      this.db.exec("DROP TABLE IF EXISTS view_topics; DROP TABLE IF EXISTS view_profile;");
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
    const placeholders = ids.map(() => "?").join(",");
    return this.db
      .prepare(`SELECT * FROM events WHERE id IN (${placeholders})`)
      .all(...ids)
      .map(rowToEvent);
  }

  /** conversation_uuids already imported from a source — lets a re-import top up only new chats, never double. */
  importedConversationUuids(source: string): Set<string> {
    const uuids = new Set<string>();
    for (const e of this.query({ source, limit: 1_000_000 })) {
      const uuid = (e.provenance as { conversation_uuid?: string }).conversation_uuid;
      if (uuid) uuids.add(uuid);
    }
    return uuids;
  }

  /** repo names already imported via `import git` — lets a re-import skip repos already on file. */
  importedGitRepos(): Set<string> {
    const repos = new Set<string>();
    for (const e of this.query({ source: "import:git", limit: 1_000_000 })) {
      const repo = (e.provenance as { repo?: string }).repo;
      if (repo) repos.add(repo);
    }
    return repos;
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
    const reads = this.query({ type: "context.read", limit: 1_000_000 }); // ts DESC
    const firstEventAt = (this.db.prepare("SELECT MIN(ts) m FROM events").get() as { m: string | null }).m;
    const firstMs = firstEventAt ? new Date(firstEventAt).getTime() : null;
    // Retention is anchored to when serving actually began (the first read), not
    // onboarding — so a gap between setup and the first read can't read as a
    // false "not retained". For a fresh install the two are minutes apart.
    const firstReadAt = reads.length ? reads[reads.length - 1]!.ts : null;
    const firstReadMs = firstReadAt ? new Date(firstReadAt).getTime() : null;

    const daily = new Map<string, number>();
    for (let i = 13; i >= 0; i--) daily.set(dayKey(now - i * DAY), 0);

    let reads7d = 0, reads30d = 0, week2Read = false;
    const days7 = new Set<string>(), days14 = new Set<string>();
    for (const e of reads) {
      const t = new Date(e.ts).getTime();
      if (!Number.isFinite(t)) continue;
      const age = now - t, k = dayKey(t);
      if (age <= 7 * DAY) { reads7d++; days7.add(k); }
      if (age <= 14 * DAY) days14.add(k);
      if (age <= 30 * DAY) reads30d++;
      if (daily.has(k)) daily.set(k, (daily.get(k) ?? 0) + 1);
      if (firstReadMs !== null && t >= firstReadMs + 7 * DAY && t < firstReadMs + 14 * DAY) week2Read = true;
    }

    return {
      firstEventAt,
      firstReadAt,
      lastReadAt: reads.length ? reads[0]!.ts : null,
      daysSinceFirst: firstMs !== null ? Math.max(0, Math.floor((now - firstMs) / DAY)) : 0,
      daysSinceFirstRead: firstReadMs !== null ? Math.max(0, Math.floor((now - firstReadMs) / DAY)) : 0,
      totalReads: reads.length,
      reads7d,
      reads30d,
      activeDays7d: days7.size,
      activeDays14d: days14.size,
      retainedWeek2: firstReadMs !== null && now >= firstReadMs + 14 * DAY ? week2Read : null,
      daily: [...daily.entries()].map(([date, r]) => ({ date, reads: r })),
    };
  }

  /** Corrections the user stated (action edit/contradict — deletes are
      tombstones, not statements). Newest first; the authoritative layer that
      ask and profile synthesis must weight above derived signals. */
  corrections(limit = 50): { id: string; ts: string; subject: string; correction: string }[] {
    return this.query({ type: "user.correction", limit: 1_000_000 })
      .filter((e) => {
        const p = e.payload as { action: string; reason: string };
        return p.action !== "delete" && p.reason.trim().length > 0;
      })
      .slice(0, limit)
      .map((e) => {
        const p = e.payload as { target_id: string; reason: string };
        return { id: e.id, ts: e.ts, subject: p.target_id, correction: p.reason };
      });
  }

  /** agent.question/agent.answer exchanges joined with the user's feedback —
      the precision surface of the ask_user_model loop. */
  askHistory(limit = 50): { items: AskRow[]; stats: AskStats } {
    const questions = new Map(this.query({ type: "agent.question", limit: 1_000_000 }).map((e) => [e.id, e]));
    // query() returns ts DESC, so the first verdict seen per answer is the latest one.
    const verdicts = new Map<string, AskRow["verdict"]>();
    for (const e of this.query({ type: "feedback.signal", limit: 1_000_000 })) {
      const p = e.payload as { subject_id: string; verdict: AskRow["verdict"] };
      if (!verdicts.has(p.subject_id)) verdicts.set(p.subject_id, p.verdict);
    }

    const all = this.query({ type: "agent.answer", limit: 1_000_000 });
    const stats: AskStats = { asked: all.length, answered: 0, deferred: 0, approved: 0, edited: 0, vetoed: 0, precision: null };
    for (const a of all) {
      if ((a.payload as { deferred: boolean }).deferred) stats.deferred++;
      else stats.answered++;
      const v = verdicts.get(a.id);
      if (v === "approved") stats.approved++;
      else if (v === "edited") stats.edited++;
      else if (v === "vetoed") stats.vetoed++;
    }
    const labeled = stats.approved + stats.edited + stats.vetoed;
    if (labeled) stats.precision = stats.approved / labeled;

    const items = all.slice(0, limit).map((a): AskRow => {
      const p = a.payload as { question_id: string; answer: string; confidence: number; deferred: boolean };
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
        verdict: verdicts.get(a.id) ?? null,
      };
    });
    return { items, stats };
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

    interface Acc { topic: string; categories: Map<string, number>; signals: WeightSignal[]; entities: Set<string>; first: string; last: string; ids: string[] }
    const acc = new Map<string, Acc>();
    for (const e of this.query({ type: "signal.topic", limit: 1_000_000 })) {
      const p = e.payload as { topic: string; weight: number; category: string; depth: string; sentiment: string; intent: string; entities: string[] };
      const key = normalizeTopic(p.topic);
      if (!key) continue;
      let a = acc.get(key);
      if (!a) {
        a = { topic: p.topic, categories: new Map(), signals: [], entities: new Set(), first: e.ts, last: e.ts, ids: [] };
        acc.set(key, a);
      }
      a.categories.set(p.category, (a.categories.get(p.category) ?? 0) + 1);
      a.signals.push({ ts: e.ts, weight: p.weight, depth: p.depth, sentiment: p.sentiment, intent: p.intent });
      for (const ent of p.entities) a.entities.add(ent);
      if (e.ts < a.first) a.first = e.ts;
      if (e.ts > a.last) a.last = e.ts;
      a.ids.push(e.id);
    }

    const rows: TopicRow[] = [...acc.entries()].map(([key, a]) => {
      const w = topicWeight(a.signals, now);
      return {
        topic_key: key,
        topic: a.topic,
        category: [...a.categories.entries()].sort((x, y) => y[1] - x[1])[0]![0],
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
    const forgotten = new Set<string>();
    for (const e of this.query({ type: "user.correction", limit: 1_000_000 })) {
      const p = e.payload as { target_id: string; action: string };
      if (p.action === "delete" && p.target_id.startsWith("style:")) forgotten.add(p.target_id);
    }
    return forgotten;
  }

  /** The voice/convention profile — style signals deduped by pattern (newest wins), richest first, forgotten patterns excluded. */
  voice(): { pack: string; items: StyleSignal[] } {
    const forgotten = this.forgottenStyleKeys();
    const byPattern = new Map<string, StyleSignal>();
    // query() returns ts DESC, so the first occurrence of a pattern is the most recent.
    for (const e of this.query({ type: "signal.style", limit: 1_000_000 })) {
      const p = e.payload as StyleSignal;
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
   * Hard-deletes a style pattern's events and writes a delete correction so it
   * stays gone even if stylometry or live capture re-derives it later — the
   * "deletable for real" promise extended to the voice layer.
   */
  forgetStyle(dimension: string, pattern: string): number {
    const key = this.styleKey(dimension, pattern);
    const candidates = this.query({ type: "signal.style", limit: 1_000_000 }).filter(
      (e) => this.styleKey((e.payload as StyleSignal).dimension, (e.payload as StyleSignal).pattern) === key,
    );
    const del = this.db.prepare("DELETE FROM events WHERE id = ?");
    const run = this.db.transaction((toDelete: string[]) => { for (const id of toDelete) del.run(id); });
    run(candidates.map((e) => e.id));
    this.append([newEvent("user.correction", "dashboard", { target_id: key, action: "delete", reason: "" }, { kind: "local", surface: "dashboard" })]);
    return candidates.length;
  }

  /** Drops style signals of one basis so a deterministic re-run replaces them (live `observed`/`correction` signals are kept). */
  clearStyleByBasis(basis: string): number {
    return this.db
      .prepare("DELETE FROM events WHERE type = 'signal.style' AND json_extract(payload, '$.basis') = ?")
      .run(basis).changes;
  }

  /**
   * Consolidation distill: bounds the stored style backlog so live capture
   * never grows unbounded. Keeps the richest signal per pattern, capped overall.
   */
  pruneStyle(maxTotal = 80): number {
    const byPattern = new Map<string, PersnallyEvent>();
    for (const e of this.query({ type: "signal.style", limit: 1_000_000 })) {
      const p = e.payload as StyleSignal;
      const key = this.styleKey(p.dimension, p.pattern);
      const existing = byPattern.get(key);
      if (!existing || (existing.payload as StyleSignal).confidence < p.confidence) byPattern.set(key, e);
    }
    const ranked = [...byPattern.entries()].sort((a, b) => (b[1].payload as StyleSignal).confidence - (a[1].payload as StyleSignal).confidence);
    const keepIds = new Set(ranked.slice(0, maxTotal).map(([, e]) => e.id));
    const all = this.query({ type: "signal.style", limit: 1_000_000 });
    const toDelete = all.filter((e) => !keepIds.has(e.id)).map((e) => e.id); // drop weaker duplicates + overflow
    const del = this.db.prepare("DELETE FROM events WHERE id = ?");
    const run = this.db.transaction((ids: string[]) => { for (const id of ids) del.run(id); });
    run(toDelete);
    return toDelete.length;
  }

  /** Hard-deletes matching topic events plus derived events referencing them, then rebuilds. */
  forgetTopic(topic: string): number {
    const key = normalizeTopic(topic);
    const candidates = this.query({ type: "signal.topic", limit: 1_000_000 }).filter(
      (e) => normalizeTopic((e.payload as { topic: string }).topic) === key,
    );
    const ids = new Set(candidates.map((e) => e.id));
    for (const e of this.query({ limit: 1_000_000 })) {
      const prov = e.provenance as { kind: string; from?: string[] };
      if (prov.kind === "derived" && prov.from?.some((id) => ids.has(id))) ids.add(e.id);
    }
    const del = this.db.prepare("DELETE FROM events WHERE id = ?");
    const run = this.db.transaction((toDelete: string[]) => {
      for (const id of toDelete) del.run(id);
    });
    run([...ids]);
    this.rebuild();
    return ids.size;
  }

  /** Removes every event from one import batch — a bad import is fully reversible. */
  forgetBatch(batch: string): number {
    const result = this.db
      .prepare("DELETE FROM events WHERE json_extract(provenance, '$.batch') = ?")
      .run(batch);
    this.rebuild();
    return result.changes;
  }

  forgetAll(): void {
    // Clear the profiles too — they're prose derived from now-deleted events.
    // Leaving them would serve a profile after a full wipe ("deletable for real").
    this.db.exec("DELETE FROM events; DELETE FROM view_topics; DELETE FROM view_profile; DELETE FROM view_scoped_profile;");
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
