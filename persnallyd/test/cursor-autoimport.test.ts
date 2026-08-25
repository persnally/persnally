/**
 * Mirrors test/autoimport.test.ts's coverage of importNewClaudeCodeSessions,
 * against importNewCursorHistory — proving the shared incremental engine
 * (incremental.ts) behaves identically for a source whose watermark is
 * bubbleId-based and whose per-message timestamp is the composer's own
 * lastUpdatedAt (coarser than claude-code's per-message precision, since
 * individual Cursor bubbles carry no timestamp of their own — verified
 * directly against ~2000 real bubbles on a real machine).
 */

import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { LlmExtract } from "../src/llm.js";
import { cursorUserDir, importNewCursorHistory } from "../src/importers/cursor.js";
import { EventStore } from "../src/store.js";

function newHome(): string {
  const home = mkdtempSync(join(tmpdir(), "cursor-autoimport-home-"));
  mkdirSync(join(cursorUserDir(home), "globalStorage"), { recursive: true });
  return home;
}

function dbPathFor(home: string): string {
  return join(cursorUserDir(home), "globalStorage", "state.vscdb");
}

/** Builds (or overwrites) a state.vscdb with one composer's current bubble set. */
function writeComposer(
  home: string,
  composerId: string,
  lastUpdatedAt: number,
  bubbles: { id: string; text: string }[],
): void {
  const path = dbPathFor(home);
  const db = new Database(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
    CREATE TABLE IF NOT EXISTS composerHeaders (composerId TEXT PRIMARY KEY, workspaceId TEXT, createdAt INTEGER, lastUpdatedAt INTEGER);
  `);
  // INSERT OR REPLACE: writeComposer is called a second time to simulate a
  // resumed composer picking up new bubbles, same composerId, updated lastUpdatedAt.
  db.prepare("INSERT OR REPLACE INTO composerHeaders (composerId, workspaceId, createdAt, lastUpdatedAt) VALUES (?, ?, ?, ?)")
    .run(composerId, "w1", lastUpdatedAt, lastUpdatedAt);
  const headersOnly = bubbles.map((b) => ({ bubbleId: b.id, type: 1 }));
  db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)")
    .run(`composerData:${composerId}`, JSON.stringify({ name: "", fullConversationHeadersOnly: headersOnly }));
  const put = db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)");
  for (const b of bubbles) put.run(`bubbleId:${composerId}:${b.id}`, JSON.stringify({ type: 1, text: b.text }));
  db.close();
}

const topicExtract: LlmExtract = async () => ({
  topics: [{ topic: "t", weight: 0.5, intent: "building", sentiment: "neutral", depth: "moderate", category: "technology", entities: [] }],
});

test("first pass imports the composer and records its conversation_uuid", async () => {
  const home = newHome();
  const dbDir = mkdtempSync(join(tmpdir(), "cursor-autoimport-db-"));
  const store = new EventStore(join(dbDir, "test.db"));
  after(() => { store.close(); rmSync(home, { recursive: true, force: true }); rmSync(dbDir, { recursive: true, force: true }); });

  writeComposer(home, "c1", 1_700_000_000_000, [{ id: "b1", text: "first prompt" }, { id: "b2", text: "second prompt" }]);

  const r = await importNewCursorHistory(store, topicExtract, "model", dbPathFor(home), home);
  assert.equal(r.newConversations, 1);
  assert.equal(r.skipped, 0);
  const uuids = store.importedConversationUuids("import:cursor");
  assert.ok(uuids.has("c1"));
});

test("second pass skips everything already imported — no extractor calls", async () => {
  const home = newHome();
  const dbDir = mkdtempSync(join(tmpdir(), "cursor-autoimport-db-"));
  const store = new EventStore(join(dbDir, "test.db"));
  after(() => { store.close(); rmSync(home, { recursive: true, force: true }); rmSync(dbDir, { recursive: true, force: true }); });
  writeComposer(home, "c1", 1_700_000_000_000, [{ id: "b1", text: "first prompt" }, { id: "b2", text: "second prompt" }]);

  let calls = 0;
  const counting: LlmExtract = async (o) => { calls++; return topicExtract(o); };
  await importNewCursorHistory(store, counting, "model", dbPathFor(home), home);
  const before = calls;
  const r = await importNewCursorHistory(store, counting, "model", dbPathFor(home), home);
  assert.equal(r.newConversations, 0);
  assert.equal(r.skipped, 1);
  assert.equal(calls, before, "extractor was not invoked for an already-seen composer");
});

test("a missing database is a no-op, not an error", async () => {
  const home = newHome();
  const dbDir = mkdtempSync(join(tmpdir(), "cursor-autoimport-db-"));
  const store = new EventStore(join(dbDir, "test.db"));
  after(() => { store.close(); rmSync(home, { recursive: true, force: true }); rmSync(dbDir, { recursive: true, force: true }); });

  const r = await importNewCursorHistory(store, topicExtract, "model", dbPathFor(home), home);
  assert.deepEqual(r, { newConversations: 0, toppedUp: 0, events: 0, skipped: 0, engineFailed: false });
});

test("a dead engine is reported as engineFailed, and stops after a few calls", async () => {
  const home = newHome();
  for (let i = 0; i < 9; i++) {
    writeComposer(home, `c${i}`, 1_700_000_000_000 + i,
      [{ id: `${i}-a`, text: `prompt a ${i}` }, { id: `${i}-b`, text: `prompt b ${i}` }]);
  }
  const dbDir = mkdtempSync(join(tmpdir(), "cursor-autoimport-dead-db-"));
  const store = new EventStore(join(dbDir, "test.db"));
  after(() => { store.close(); rmSync(home, { recursive: true, force: true }); rmSync(dbDir, { recursive: true, force: true }); });

  let calls = 0;
  const dead: LlmExtract = async () => { calls++; throw new Error("400 credit balance is too low"); };
  const r = await importNewCursorHistory(store, dead, "model", dbPathFor(home), home);

  assert.equal(r.engineFailed, true);
  assert.equal(r.newConversations, 9, "the composers were seen");
  assert.ok(calls <= 4, `fail-fast must cap the wasted calls; made ${calls} for 9 composers`);
  assert.equal(store.importedConversationUuids("import:cursor").size, 0,
    "nothing marked imported — which is why the caller has to back off");
});

// ── A resumed composer: new bubbles appended since the last import ──────────

test("a resumed composer tops up with only the messages past its watermark", async () => {
  const home = newHome();
  const dbDir = mkdtempSync(join(tmpdir(), "cursor-autoimport-topup-db-"));
  const store = new EventStore(join(dbDir, "test.db"));
  after(() => { store.close(); rmSync(home, { recursive: true, force: true }); rmSync(dbDir, { recursive: true, force: true }); });

  writeComposer(home, "r1", 1_700_000_000_000,
    [{ id: "m1", text: "original first prompt" }, { id: "m2", text: "original second prompt" }]);

  const seenContents: string[] = [];
  const spy: LlmExtract = async ({ content }) => {
    seenContents.push(content);
    return { topics: [{ topic: "t", weight: 0.5, intent: "building", sentiment: "neutral", depth: "moderate", category: "technology", entities: [] }] };
  };

  const first = await importNewCursorHistory(store, spy, "model", dbPathFor(home), home);
  assert.equal(first.newConversations, 1);
  assert.equal(first.toppedUp, 0);
  assert.equal(store.conversationWatermarks("import:cursor").get("r1"), "m2");

  const idle = await importNewCursorHistory(store, spy, "model", dbPathFor(home), home);
  assert.equal(idle.toppedUp, 0);
  assert.equal(idle.skipped, 1);
  assert.equal(seenContents.length, 1);

  // The composer resumes: two more bubbles, a later lastUpdatedAt.
  writeComposer(home, "r1", 1_700_000_500_000, [
    { id: "m1", text: "original first prompt" }, { id: "m2", text: "original second prompt" },
    { id: "m3", text: "resumed third prompt about sqlite" }, { id: "m4", text: "resumed fourth prompt about wal mode" },
  ]);

  const topped = await importNewCursorHistory(store, spy, "model", dbPathFor(home), home);
  assert.equal(topped.toppedUp, 1);
  assert.equal(topped.newConversations, 0);

  const delta = seenContents[1]!;
  assert.match(delta, /resumed third prompt/);
  assert.match(delta, /resumed fourth prompt/);
  assert.doesNotMatch(delta, /original first prompt/, "already-imported messages are not re-sent");
  assert.doesNotMatch(delta, /original second prompt/);
  assert.equal(store.conversationWatermarks("import:cursor").get("r1"), "m4", "the watermark advanced");

  const again = await importNewCursorHistory(store, spy, "model", dbPathFor(home), home);
  assert.equal(again.toppedUp, 0);
  assert.equal(seenContents.length, 2);
});

test("a single new bubble stays below the top-up threshold until more accrue", async () => {
  const home = newHome();
  const dbDir = mkdtempSync(join(tmpdir(), "cursor-autoimport-threshold-db-"));
  const store = new EventStore(join(dbDir, "test.db"));
  after(() => { store.close(); rmSync(home, { recursive: true, force: true }); rmSync(dbDir, { recursive: true, force: true }); });

  writeComposer(home, "t1", 1_700_000_000_000, [{ id: "m1", text: "first" }, { id: "m2", text: "second" }]);
  let calls = 0;
  const counting: LlmExtract = async (o) => { calls++; return topicExtract(o); };

  await importNewCursorHistory(store, counting, "model", dbPathFor(home), home);
  assert.equal(calls, 1);

  writeComposer(home, "t1", 1_700_000_100_000,
    [{ id: "m1", text: "first" }, { id: "m2", text: "second" }, { id: "m3", text: "third" }]);
  const below = await importNewCursorHistory(store, counting, "model", dbPathFor(home), home);
  assert.equal(below.toppedUp, 0);
  assert.equal(calls, 1, "no extraction for a one-message delta");

  writeComposer(home, "t1", 1_700_000_200_000,
    [{ id: "m1", text: "first" }, { id: "m2", text: "second" }, { id: "m3", text: "third" }, { id: "m4", text: "fourth" }]);
  const at = await importNewCursorHistory(store, counting, "model", dbPathFor(home), home);
  assert.equal(at.toppedUp, 1);
  assert.equal(calls, 2);
  assert.equal(store.conversationWatermarks("import:cursor").get("t1"), "m4");
});
