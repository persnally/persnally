/**
 * The derived reads that moved from "pull every event into JS" to SQL. These
 * cover the cases that rewrite could plausibly break: timezone offsets in
 * stored timestamps, windows that fall outside the bounded scan, re-submitted
 * feedback, and the delete paths that walk provenance.
 */

import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { loadConfig, saveConfig } from "../src/config.js";
import { newEvent } from "../src/events.js";
import { EventStore } from "../src/store.js";

const NOW = Date.parse("2026-06-25T12:00:00Z");
const DAY = 86_400_000;

function freshStore(): EventStore {
  const dir = mkdtempSync(join(tmpdir(), "hotpath-"));
  const store = new EventStore(join(dir, "t.db"));
  after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return store;
}

const readAt = (ts: string) =>
  newEvent("context.read", "cli", { scope: "brief", client_purpose: "t", items: 1 }, { kind: "local", surface: "cli" }, ts);
const readDaysAgo = (d: number) => readAt(new Date(NOW - d * DAY).toISOString());
const topicNamed = (topic: string, ts?: string) =>
  newEvent("signal.topic", "cli", {
    topic, weight: 0.6, intent: "building", sentiment: "neutral", depth: "moderate", category: "technology", entities: [],
  }, { kind: "local", surface: "cli" }, ts);

describe("activity: bounded scan, exact windows", () => {
  test("timestamps carrying a UTC offset land in the right day and window", () => {
    const store = freshStore();
    // 2026-06-25T02:00+05:30 is 2026-06-24T20:30Z — a different calendar day
    // than the local one. String comparison would file it under the 25th.
    store.append([
      readAt("2026-06-25T02:00:00+05:30"),
      readAt("2026-06-24T23:30:00-05:00"), // = 2026-06-25T04:30Z
    ]);
    const a = store.activity(NOW);
    assert.equal(a.totalReads, 2);
    assert.equal(a.reads7d, 2, "both are within the week regardless of offset");
    const byDay = new Map(a.daily.map((d) => [d.date, d.reads]));
    assert.equal(byDay.get("2026-06-24"), 1, "the +05:30 read belongs to the 24th in UTC");
    assert.equal(byDay.get("2026-06-25"), 1, "the -05:00 read belongs to the 25th in UTC");
  });

  test("week-2 retention still resolves when it falls outside the 30-day window", () => {
    const store = freshStore();
    // First read 200 days ago: days 8–14 after it are ~190 days back, far
    // outside the bounded window the buckets read.
    store.append([
      readDaysAgo(200),
      readDaysAgo(190), // day 10 after the first read
      readDaysAgo(1),
    ]);
    const a = store.activity(NOW);
    assert.equal(a.totalReads, 3);
    assert.equal(a.retainedWeek2, true, "an old install's week-2 verdict must not depend on the recent window");
    assert.equal(a.reads7d, 1, "only the recent read is inside the week");
    assert.equal(a.reads30d, 1);
  });

  test("no read in days 8-14 reports false, not a missing verdict", () => {
    const store = freshStore();
    store.append([readDaysAgo(100), readDaysAgo(99), readDaysAgo(1)]);
    assert.equal(store.activity(NOW).retainedWeek2, false);
  });

  test("totals count every read while the buckets stay windowed", () => {
    const store = freshStore();
    store.append([...Array.from({ length: 40 }, (_, i) => readDaysAgo(i * 5))]); // spans 200 days
    const a = store.activity(NOW);
    assert.equal(a.totalReads, 40, "COUNT(*) sees all of them");
    assert.equal(a.reads7d, 2, "days 0 and 5");
    assert.equal(a.reads30d, 7, "days 0,5,10,15,20,25,30 — the 30-day bound is inclusive");
    assert.equal(a.firstReadAt, new Date(NOW - 195 * DAY).toISOString());
    assert.equal(a.lastReadAt, new Date(NOW).toISOString());
  });
});

describe("askHistory: counts in SQL", () => {
  function seedAsk(store: EventStore, n: number, deferred = false) {
    const q = newEvent("agent.question", "mcp:cursor", { question: `q${n}`, asker: "cursor" }, { kind: "mcp", client: "cursor" });
    const a = newEvent("agent.answer", "mcp:cursor", {
      question_id: q.id, answer: `a${n}`, confidence: 0.8, deferred, evidence_event_ids: [],
    }, { kind: "mcp", client: "cursor" });
    store.append([q, a]);
    return a.id;
  }
  const verdict = (subject: string, v: string) =>
    newEvent("feedback.signal", "dashboard", { subject_id: subject, verdict: v }, { kind: "local", surface: "dashboard" });

  test("asked/answered/deferred are counted over every answer", () => {
    const store = freshStore();
    seedAsk(store, 1);
    seedAsk(store, 2);
    seedAsk(store, 3, true);
    const { stats } = store.askHistory();
    assert.deepEqual(
      { asked: stats.asked, answered: stats.answered, deferred: stats.deferred },
      { asked: 3, answered: 2, deferred: 1 },
    );
  });

  test("a re-submitted verdict counts once, under the latest value", () => {
    const store = freshStore();
    const id = seedAsk(store, 1);
    store.append([verdict(id, "vetoed")]);
    store.append([verdict(id, "approved")]); // the user changed their mind
    const { stats, items } = store.askHistory();
    assert.equal(stats.approved, 1);
    assert.equal(stats.vetoed, 0, "the superseded verdict must not also be counted");
    assert.equal(stats.precision, 1);
    assert.equal(items[0]?.verdict, "approved");
  });

  test("precision is approved over labeled, and items join their question text", () => {
    const store = freshStore();
    const a1 = seedAsk(store, 1);
    const a2 = seedAsk(store, 2);
    seedAsk(store, 3); // unlabeled
    store.append([verdict(a1, "approved"), verdict(a2, "vetoed")]);
    const { stats, items } = store.askHistory();
    assert.equal(stats.precision, 0.5);
    assert.equal(items.length, 3);
    assert.ok(items.every((i) => i.question.startsWith("q")), "each row resolved its question");
    assert.ok(items.every((i) => i.asker === "cursor"));
  });

  test("the limit bounds the rows read back, not the stats", () => {
    const store = freshStore();
    for (let i = 0; i < 12; i++) seedAsk(store, i);
    const { items, stats } = store.askHistory(5);
    assert.equal(items.length, 5);
    assert.equal(stats.asked, 12, "stats still cover every answer");
  });
});

describe("corrections: filtered and limited in SQL", () => {
  const correction = (target: string, action: string, reason: string) =>
    newEvent("user.correction", "cli", { target_id: target, action, reason }, { kind: "local", surface: "cli" });

  test("delete tombstones and blank reasons are excluded", () => {
    const store = freshStore();
    store.append([
      correction("topic:a", "contradict", "actually rust"),
      correction("style:voice|x", "delete", ""),
      correction("topic:b", "edit", "   "), // whitespace only
    ]);
    const rows = store.corrections();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.subject, "topic:a");
    assert.equal(rows[0]?.correction, "actually rust");
  });

  test("newest first, capped at the limit", () => {
    const store = freshStore();
    for (let i = 0; i < 8; i++) store.append([correction(`t${i}`, "edit", `r${i}`)]);
    const rows = store.corrections(3);
    assert.equal(rows.length, 3);
    const times = rows.map((r) => r.ts);
    assert.deepEqual([...times].sort().reverse(), times, "descending by ts");
  });
});

describe("delete paths", () => {
  test("forgetTopic removes the topic's events and anything derived from them", () => {
    const store = freshStore();
    const keep = topicNamed("elixir");
    const target = topicNamed("Rust");
    store.append([keep, target]);
    const derived = newEvent("signal.assertion", "cli",
      { claim: "likes rust", kind: "behavior", confidence: 0.8, evidence: "x" },
      { kind: "derived", from: [target.id] });
    const unrelated = newEvent("signal.assertion", "cli",
      { claim: "likes elixir", kind: "behavior", confidence: 0.8, evidence: "x" },
      { kind: "derived", from: [keep.id] });
    store.append([derived, unrelated]);

    // normalizeTopic folds case, so "rust" must match the stored "Rust".
    assert.equal(store.forgetTopic("rust"), 2, "the topic event plus its derived assertion");
    const left = store.getEvents([keep.id, target.id, derived.id, unrelated.id]).map((e) => e.id);
    assert.deepEqual(left.sort(), [keep.id, unrelated.id].sort());
  });

  test("forgetStyle matches case-insensitively and tombstones the pattern", () => {
    const store = freshStore();
    const style = (pattern: string) =>
      newEvent("signal.style", "cli", {
        dimension: "voice", pattern, polarity: "does", confidence: 0.9, evidence: "e", basis: "stylometry",
      }, { kind: "local", surface: "cli" });
    store.append([style("Terse Imperatives"), style("hedges rarely")]);

    assert.equal(store.forgetStyle("voice", "TERSE IMPERATIVES"), 1);
    const patterns = store.voice().items.map((i) => i.pattern);
    assert.deepEqual(patterns, ["hedges rarely"]);
    // Re-observing it must not resurrect it — the tombstone outranks the signal.
    store.append([style("Terse Imperatives")]);
    assert.deepEqual(store.voice().items.map((i) => i.pattern), ["hedges rarely"]);
  });

  test("pruneStyle keeps the richest signal per pattern", () => {
    const store = freshStore();
    const style = (pattern: string, confidence: number) =>
      newEvent("signal.style", "cli", {
        dimension: "voice", pattern, polarity: "does", confidence, evidence: "e", basis: "observed",
      }, { kind: "local", surface: "cli" });
    store.append([style("a", 0.3), style("a", 0.9), style("b", 0.5)]);
    assert.equal(store.pruneStyle(80), 1, "the weaker duplicate of 'a' goes");
    const items = store.voice().items;
    assert.equal(items.length, 2);
    assert.equal(items.find((i) => i.pattern === "a")?.confidence, 0.9);
  });
});

describe("bounded lookups and migration", () => {
  test("getEvents caps the id list instead of overflowing SQLite's bind limit", () => {
    const store = freshStore();
    const events = Array.from({ length: 20 }, (_, i) => topicNamed(`t${i}`));
    store.append(events);
    const padded = [...events.map((e) => e.id), ...Array.from({ length: 40_000 }, (_, i) => `missing-${i}`)];
    const found = store.getEvents(padded); // would throw SQLITE_TOOBIG unbounded
    assert.ok(found.length > 0 && found.length <= 500);
  });

  test("a view-schema bump re-derives scoped profiles instead of keeping stale ones", () => {
    const dir = mkdtempSync(join(tmpdir(), "hotpath-mig-"));
    const path = join(dir, "t.db");
    after(() => rmSync(dir, { recursive: true, force: true }));

    const first = new EventStore(path);
    first.append([topicNamed("rust")]);
    first.rebuild();
    first.saveScopedProfile("technology", { headline: "stale", sections: [], generated_at: "2026-01-01T00:00:00Z", model: "m" });
    assert.equal(first.getScopedProfile("technology")?.headline, "stale");
    first.close();

    // Force the next open to look like a schema upgrade, from outside the store.
    const raw = new Database(path);
    raw.pragma("user_version = 0");
    raw.close();

    const reopened = new EventStore(path);
    assert.equal(reopened.getScopedProfile("technology"), null, "the stale scoped profile was dropped");
    assert.equal(reopened.topics().length, 1, "topics re-derived from the event log");
    reopened.close();
  });

  test("recorded_at is indexed, since consolidation selects on it", () => {
    const dir = mkdtempSync(join(tmpdir(), "hotpath-idx-"));
    const path = join(dir, "t.db");
    after(() => rmSync(dir, { recursive: true, force: true }));
    const store = new EventStore(path);
    store.close();

    const raw = new Database(path);
    const plan = raw
      .prepare("EXPLAIN QUERY PLAN SELECT * FROM events WHERE recorded_at >= ?")
      .all("2026-01-01T00:00:00Z")
      .map((r) => (r as { detail: string }).detail)
      .join(" ");
    raw.close();
    assert.match(plan, /idx_events_recorded/, `expected an index scan, got: ${plan}`);
  });
});

describe("config: a corrupt file is loud, not silently empty", () => {
  test("keeps a copy and warns instead of dropping the key and scopes", (t) => {
    const dir = mkdtempSync(join(tmpdir(), "hotpath-cfg-"));
    const prev = process.env.PERSNALLY_DIR;
    process.env.PERSNALLY_DIR = dir;
    after(() => {
      if (prev === undefined) delete process.env.PERSNALLY_DIR; else process.env.PERSNALLY_DIR = prev;
      rmSync(dir, { recursive: true, force: true });
    });

    saveConfig({ anthropic_api_key: "sk-ant-real", client_scopes: { cursor: ["technology"] } });
    writeFileSync(join(dir, "config.json"), '{"anthropic_api_key": "sk-ant-tru');

    const errors: string[] = [];
    t.mock.method(console, "error", (msg: unknown) => { errors.push(String(msg)); });
    assert.deepEqual(loadConfig(), {}, "unparseable config still degrades to empty");
    assert.equal(errors.length, 1);
    assert.match(errors[0] ?? "", /unreadable/);
    assert.match(errors[0] ?? "", /config\.json\.corrupt/);

    const salvaged = readFileSync(join(dir, "config.json.corrupt"), "utf-8");
    assert.match(salvaged, /sk-ant-tru/, "the original bytes were preserved for recovery");
  });
});
