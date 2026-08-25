/**
 * Mirrors test/autoimport.test.ts's coverage of importNewClaudeCodeSessions,
 * against importNewCodexSessions — proving the shared incremental engine
 * (incremental.ts) behaves identically for Codex, whose per-message watermark
 * (client_id) and per-message timestamp (the rollout line's own outer
 * timestamp) give it the same precision claude-code.ts has — verified
 * directly against real rollout files, unlike Cursor's coarser fallback.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { LlmExtract } from "../src/llm.js";
import { importNewCodexSessions } from "../src/importers/codex.js";
import { EventStore } from "../src/store.js";

const lines = (...entries: unknown[]) => entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
const sessionMeta = (id: string, cwd: string, ts: string) =>
  ({ timestamp: ts, type: "session_meta", payload: { id, cwd, timestamp: ts, originator: "Codex CLI" } });
const userMsg = (message: string, clientId: string, ts: string) =>
  ({ timestamp: ts, type: "event_msg", payload: { type: "user_message", message, client_id: clientId } });

function rolloutDir(base: string): string {
  const dir = join(base, "2026", "08", "20");
  mkdirSync(dir, { recursive: true });
  return dir;
}

const topicExtract: LlmExtract = async () => ({
  topics: [{ topic: "t", weight: 0.5, intent: "building", sentiment: "neutral", depth: "moderate", category: "technology", entities: [] }],
});

test("first pass imports the session and records its conversation_uuid", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-autoimport-"));
  const dbDir = mkdtempSync(join(tmpdir(), "codex-autoimport-db-"));
  const store = new EventStore(join(dbDir, "test.db"));
  after(() => { store.close(); rmSync(root, { recursive: true, force: true }); rmSync(dbDir, { recursive: true, force: true }); });

  const dir = rolloutDir(root);
  writeFileSync(join(dir, "rollout-a.jsonl"), lines(
    sessionMeta("s1", "/x", "2026-08-20T10:00:00.000Z"),
    userMsg("first prompt", "m1", "2026-08-20T10:00:00.000Z"),
    userMsg("second prompt", "m2", "2026-08-20T10:01:00.000Z"),
  ));

  const r = await importNewCodexSessions(store, topicExtract, "model", root);
  assert.equal(r.newConversations, 1);
  assert.equal(r.skipped, 0);
  assert.ok(store.importedConversationUuids("import:codex").has("s1"));
});

test("second pass skips everything already imported — no extractor calls", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-autoimport-"));
  const dbDir = mkdtempSync(join(tmpdir(), "codex-autoimport-db-"));
  const store = new EventStore(join(dbDir, "test.db"));
  after(() => { store.close(); rmSync(root, { recursive: true, force: true }); rmSync(dbDir, { recursive: true, force: true }); });
  const dir = rolloutDir(root);
  writeFileSync(join(dir, "rollout-a.jsonl"), lines(
    sessionMeta("s1", "/x", "2026-08-20T10:00:00.000Z"),
    userMsg("first prompt", "m1", "2026-08-20T10:00:00.000Z"),
    userMsg("second prompt", "m2", "2026-08-20T10:01:00.000Z"),
  ));

  let calls = 0;
  const counting: LlmExtract = async (o) => { calls++; return topicExtract(o); };
  await importNewCodexSessions(store, counting, "model", root);
  const before = calls;
  const r = await importNewCodexSessions(store, counting, "model", root);
  assert.equal(r.newConversations, 0);
  assert.equal(r.skipped, 1);
  assert.equal(calls, before, "extractor was not invoked for an already-seen session");
});

test("a missing sessions directory is a no-op, not an error", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-autoimport-"));
  const dbDir = mkdtempSync(join(tmpdir(), "codex-autoimport-db-"));
  const store = new EventStore(join(dbDir, "test.db"));
  after(() => { store.close(); rmSync(root, { recursive: true, force: true }); rmSync(dbDir, { recursive: true, force: true }); });

  const r = await importNewCodexSessions(store, topicExtract, "model", join(root, "does-not-exist"));
  assert.deepEqual(r, { newConversations: 0, toppedUp: 0, events: 0, skipped: 0, engineFailed: false });
});

test("a dead engine is reported as engineFailed, and stops after a few calls", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-autoimport-dead-"));
  const dir = rolloutDir(root);
  for (let i = 0; i < 9; i++) {
    writeFileSync(join(dir, `rollout-${i}.jsonl`), lines(
      sessionMeta(`dead${i}`, "/x", "2026-08-20T10:00:00.000Z"),
      userMsg(`prompt a ${i}`, `${i}-a`, "2026-08-20T10:00:00.000Z"),
      userMsg(`prompt b ${i}`, `${i}-b`, "2026-08-20T10:01:00.000Z"),
    ));
  }
  const dbDir = mkdtempSync(join(tmpdir(), "codex-autoimport-dead-db-"));
  const store = new EventStore(join(dbDir, "test.db"));
  after(() => { store.close(); rmSync(root, { recursive: true, force: true }); rmSync(dbDir, { recursive: true, force: true }); });

  let calls = 0;
  const dead: LlmExtract = async () => { calls++; throw new Error("400 credit balance is too low"); };
  const r = await importNewCodexSessions(store, dead, "model", root);

  assert.equal(r.engineFailed, true);
  assert.equal(r.newConversations, 9, "the sessions were seen");
  assert.ok(calls <= 4, `fail-fast must cap the wasted calls; made ${calls} for 9 sessions`);
  assert.equal(store.importedConversationUuids("import:codex").size, 0,
    "nothing marked imported — which is why the caller has to back off");
});

// ── A resumed session: new lines appended to the same rollout file ──────────

test("a resumed session tops up with only the messages past its watermark", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-autoimport-topup-"));
  const dbDir = mkdtempSync(join(tmpdir(), "codex-autoimport-topup-db-"));
  const store = new EventStore(join(dbDir, "test.db"));
  after(() => { store.close(); rmSync(root, { recursive: true, force: true }); rmSync(dbDir, { recursive: true, force: true }); });

  const dir = rolloutDir(root);
  const file = join(dir, "rollout-r1.jsonl");
  writeFileSync(file, lines(
    sessionMeta("r1", "/x", "2026-08-20T10:00:00.000Z"),
    userMsg("original first prompt", "m1", "2026-08-20T10:00:00.000Z"),
    userMsg("original second prompt", "m2", "2026-08-20T10:05:00.000Z"),
  ));

  const seenContents: string[] = [];
  const spy: LlmExtract = async ({ content }) => {
    seenContents.push(content);
    return { topics: [{ topic: "t", weight: 0.5, intent: "building", sentiment: "neutral", depth: "moderate", category: "technology", entities: [] }] };
  };

  const first = await importNewCodexSessions(store, spy, "model", root);
  assert.equal(first.newConversations, 1);
  assert.equal(first.toppedUp, 0);
  assert.equal(store.conversationWatermarks("import:codex").get("r1"), "m2");

  const idle = await importNewCodexSessions(store, spy, "model", root);
  assert.equal(idle.toppedUp, 0);
  assert.equal(idle.skipped, 1);
  assert.equal(seenContents.length, 1);

  // The session resumes: two more lines appended to the same file.
  writeFileSync(file, lines(
    sessionMeta("r1", "/x", "2026-08-20T10:00:00.000Z"),
    userMsg("original first prompt", "m1", "2026-08-20T10:00:00.000Z"),
    userMsg("original second prompt", "m2", "2026-08-20T10:05:00.000Z"),
    userMsg("resumed third prompt about sqlite", "m3", "2026-08-24T09:00:00.000Z"),
    userMsg("resumed fourth prompt about wal mode", "m4", "2026-08-24T09:10:00.000Z"),
  ));

  const topped = await importNewCodexSessions(store, spy, "model", root);
  assert.equal(topped.toppedUp, 1);
  assert.equal(topped.newConversations, 0);

  const delta = seenContents[1]!;
  assert.match(delta, /resumed third prompt/);
  assert.match(delta, /resumed fourth prompt/);
  assert.doesNotMatch(delta, /original first prompt/, "already-imported messages are not re-sent");
  assert.doesNotMatch(delta, /original second prompt/);
  assert.equal(store.conversationWatermarks("import:codex").get("r1"), "m4", "the watermark advanced");

  // Top-up topics carry the resume-time ts, so decay treats the activity as
  // current rather than as old as the session's original start.
  const topicEvents = store.query({ type: "signal.topic", source: "import:codex", limit: 100 })
    .filter((e) => (e.provenance as { message_uuid?: string }).message_uuid === "m4");
  assert.ok(topicEvents.length > 0);
  assert.equal(topicEvents[0]!.ts, "2026-08-24T09:00:00.000Z");

  const again = await importNewCodexSessions(store, spy, "model", root);
  assert.equal(again.toppedUp, 0);
  assert.equal(seenContents.length, 2);
});

test("a single new message stays below the top-up threshold until more accrue", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-autoimport-threshold-"));
  const dbDir = mkdtempSync(join(tmpdir(), "codex-autoimport-threshold-db-"));
  const store = new EventStore(join(dbDir, "test.db"));
  after(() => { store.close(); rmSync(root, { recursive: true, force: true }); rmSync(dbDir, { recursive: true, force: true }); });

  const dir = rolloutDir(root);
  const file = join(dir, "rollout-t1.jsonl");
  const base = [sessionMeta("t1", "/x", "2026-08-20T10:00:00.000Z"), userMsg("first", "m1", "2026-08-20T10:00:00.000Z"), userMsg("second", "m2", "2026-08-20T10:01:00.000Z")];
  writeFileSync(file, lines(...base));

  let calls = 0;
  const counting: LlmExtract = async (o) => { calls++; return topicExtract(o); };

  await importNewCodexSessions(store, counting, "model", root);
  assert.equal(calls, 1);

  writeFileSync(file, lines(...base, userMsg("third", "m3", "2026-08-20T10:02:00.000Z")));
  const below = await importNewCodexSessions(store, counting, "model", root);
  assert.equal(below.toppedUp, 0);
  assert.equal(calls, 1, "no extraction for a one-message delta");

  writeFileSync(file, lines(...base, userMsg("third", "m3", "2026-08-20T10:02:00.000Z"), userMsg("fourth", "m4", "2026-08-20T10:03:00.000Z")));
  const at = await importNewCodexSessions(store, counting, "model", root);
  assert.equal(at.toppedUp, 1);
  assert.equal(calls, 2);
  assert.equal(store.conversationWatermarks("import:codex").get("t1"), "m4");
});
