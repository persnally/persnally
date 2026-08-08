import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { LlmExtract } from "../src/llm.js";
import { importNewClaudeCodeSessions } from "../src/importers/claude-code.js";
import { EventStore } from "../src/store.js";

const root = mkdtempSync(join(tmpdir(), "autoimport-transcripts-"));
const dbDir = mkdtempSync(join(tmpdir(), "autoimport-db-"));
const store = new EventStore(join(dbDir, "test.db"));
after(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(dbDir, { recursive: true, force: true });
});

// One topic per conversation — the import path only calls the topics extraction
// for Claude Code (no memory/projects), so this is all the mock must answer.
let extractCalls = 0;
const extract: LlmExtract = async () => {
  extractCalls++;
  return {
    topics: [{
      topic: "test topic", weight: 0.5, intent: "building", sentiment: "neutral",
      depth: "moderate", category: "technology", entities: [],
    }],
  };
};

const user = (text: string, sessionId: string, ts = "2026-06-01T10:00:00Z") =>
  JSON.stringify({ type: "user", message: { role: "user", content: text }, timestamp: ts, sessionId, cwd: "/x" });

function writeSession(sessionId: string): void {
  const dir = join(root, "-x");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionId}.jsonl`),
    [user("first prompt", sessionId), user("second prompt", sessionId)].join("\n") + "\n");
}

writeSession("s1");
writeSession("s2");

test("first pass imports every session and records each conversation_uuid", async () => {
  const r = await importNewClaudeCodeSessions(store, extract, "model", root);
  assert.equal(r.newSessions, 2);
  assert.equal(r.skipped, 0);
  assert.ok(r.events >= 2, "at least the two topic events landed");
  const topics = store.query({ type: "signal.topic", source: "import:claude-code", limit: 100 });
  const uuids = new Set(topics.map((e) => (e.provenance as { conversation_uuid?: string }).conversation_uuid));
  assert.deepEqual([...uuids].sort(), ["s1", "s2"]);
});

test("second pass skips everything already imported — no extractor calls", async () => {
  const before = extractCalls;
  const r = await importNewClaudeCodeSessions(store, extract, "model", root);
  assert.equal(r.newSessions, 0);
  assert.equal(r.skipped, 2);
  assert.equal(r.events, 0);
  assert.equal(extractCalls, before, "extractor was not invoked for already-seen sessions");
});

test("only the genuinely new session is imported on a later pass", async () => {
  writeSession("s3");
  const r = await importNewClaudeCodeSessions(store, extract, "model", root);
  assert.equal(r.newSessions, 1);
  assert.equal(r.skipped, 2);
  const uuids = new Set(
    store.query({ type: "signal.topic", source: "import:claude-code", limit: 100 })
      .map((e) => (e.provenance as { conversation_uuid?: string }).conversation_uuid),
  );
  assert.deepEqual([...uuids].sort(), ["s1", "s2", "s3"]);
});

test("a missing transcripts directory is a no-op, not an error", async () => {
  const r = await importNewClaudeCodeSessions(store, extract, "model", join(root, "does-not-exist"));
  assert.deepEqual(r, { newSessions: 0, toppedUp: 0, events: 0, skipped: 0, engineFailed: false });
});

test("a session imported before watermarks existed never tops up — re-paying would double its signals", async () => {
  // s1's fixture lines carry no per-message uuid, exactly like a legacy import.
  const dir = join(root, "-x");
  writeFileSync(join(dir, "s1.jsonl"),
    [user("first prompt", "s1"), user("second prompt", "s1"),
     user("third prompt added later", "s1"), user("fourth prompt added later", "s1")].join("\n") + "\n");

  const before = extractCalls;
  const r = await importNewClaudeCodeSessions(store, extract, "model", root);

  assert.equal(r.toppedUp, 0);
  assert.equal(r.newSessions, 0);
  assert.equal(extractCalls, before, "no extraction was paid for");
});

test("one conversation's malformed extraction is skipped; the rest still import", async () => {
  const root2 = mkdtempSync(join(tmpdir(), "autoimport-resilience-"));
  const dbDir2 = mkdtempSync(join(tmpdir(), "autoimport-resilience-db-"));
  const store2 = new EventStore(join(dbDir2, "test.db"));
  after(() => {
    store2.close();
    rmSync(root2, { recursive: true, force: true });
    rmSync(dbDir2, { recursive: true, force: true });
  });
  const dir = join(root2, "-x");
  mkdirSync(dir, { recursive: true });
  for (const id of ["a", "b", "c"]) {
    writeFileSync(join(dir, `${id}.jsonl`),
      [user("first prompt", id), user("second prompt", id)].join("\n") + "\n");
  }
  // Throw on the second extraction call — mirrors the model returning an
  // out-of-enum value that fails schema validation for one conversation.
  let n = 0;
  const flaky: LlmExtract = async () => {
    if (++n === 2) throw new Error("Invalid option: expected one of ...");
    return {
      topics: [{
        topic: "t", weight: 0.5, intent: "building", sentiment: "neutral",
        depth: "moderate", category: "technology", entities: [],
      }],
    };
  };
  const r = await importNewClaudeCodeSessions(store2, flaky, "model", root2);
  assert.equal(r.newSessions, 3, "all three were considered new");
  const succeeded = new Set(
    store2.query({ type: "signal.topic", source: "import:claude-code", limit: 100 })
      .map((e) => (e.provenance as { conversation_uuid?: string }).conversation_uuid),
  );
  assert.equal(succeeded.size, 2, "the two valid sessions imported; the failed one was skipped, not fatal");
});

test("a dead engine is reported as engineFailed, and stops after a few calls", async () => {
  const dir = mkdtempSync(join(tmpdir(), "autoimport-dead-"));
  const sessions = join(dir, "-p");
  mkdirSync(sessions, { recursive: true });
  for (let i = 0; i < 9; i++) {
    writeFileSync(join(sessions, `dead${i}.jsonl`),
      [user(`prompt a ${i}`, `dead${i}`), user(`prompt b ${i}`, `dead${i}`)].join("\n") + "\n");
  }
  const dbDir = mkdtempSync(join(tmpdir(), "autoimport-dead-db-"));
  const s = new EventStore(join(dbDir, "t.db"));
  after(() => { s.close(); rmSync(dir, { recursive: true, force: true }); rmSync(dbDir, { recursive: true, force: true }); });

  let calls = 0;
  const dead: LlmExtract = async () => { calls++; throw new Error("400 credit balance is too low"); };
  const r = await importNewClaudeCodeSessions(s, dead, "model", dir);

  assert.equal(r.engineFailed, true, "an engine that never succeeds must be reported, not silently retried");
  assert.equal(r.newSessions, 9, "the sessions were seen");
  assert.ok(calls <= 4, `fail-fast must cap the wasted calls; made ${calls} for 9 conversations`);
  assert.equal(s.importedConversationUuids("import:claude-code").size, 0,
    "nothing marked imported — which is why the caller has to back off");
});

test("a working engine reports engineFailed false", async () => {
  const dbDir = mkdtempSync(join(tmpdir(), "autoimport-ok-db-"));
  const s = new EventStore(join(dbDir, "t.db"));
  after(() => { s.close(); rmSync(dbDir, { recursive: true, force: true }); });
  const r = await importNewClaudeCodeSessions(s, extract, "model", root);
  assert.equal(r.engineFailed, false);
  assert.ok(r.newSessions > 0);
});

// ── Resumed sessions: `claude --continue` appends to the same JSONL ──────────
// Before watermarks, dedup was by sessionId alone: once imported, every later
// message in that session was invisible forever. For someone who lives in a
// few long-running sessions, the 30-minute loop captured almost nothing.

test("a resumed session tops up with only the messages past its watermark", async (t) => {
  const root2 = mkdtempSync(join(tmpdir(), "autoimport-topup-"));
  const dbDir2 = mkdtempSync(join(tmpdir(), "autoimport-topup-db-"));
  const store2 = new EventStore(join(dbDir2, "test.db"));
  t.after(() => {
    store2.close();
    rmSync(root2, { recursive: true, force: true });
    rmSync(dbDir2, { recursive: true, force: true });
  });

  const dir = join(root2, "-x");
  mkdirSync(dir, { recursive: true });
  const line = (text: string, uuid: string, ts: string) => JSON.stringify({
    type: "user", uuid, sessionId: "r1", cwd: "/x", timestamp: ts,
    message: { role: "user", content: text },
  });
  const file = join(dir, "r1.jsonl");
  writeFileSync(file,
    [line("original first prompt", "m1", "2026-08-01T10:00:00Z"),
     line("original second prompt", "m2", "2026-08-01T10:05:00Z")].join("\n") + "\n");

  const seenContents: string[] = [];
  const spy: LlmExtract = async ({ content }) => {
    seenContents.push(content);
    return {
      topics: [{
        topic: "test topic", weight: 0.5, intent: "building", sentiment: "neutral",
        depth: "moderate", category: "technology", entities: [],
      }],
    };
  };

  // Pass 1: whole session, watermark lands on the last message.
  const first = await importNewClaudeCodeSessions(store2, spy, "model", root2);
  assert.equal(first.newSessions, 1);
  assert.equal(first.toppedUp, 0);
  assert.equal(store2.conversationWatermarks("import:claude-code").get("r1"), "m2");

  // Pass 2: nothing new → nothing paid.
  const idle = await importNewClaudeCodeSessions(store2, spy, "model", root2);
  assert.equal(idle.toppedUp, 0);
  assert.equal(idle.skipped, 1);
  assert.equal(seenContents.length, 1);

  // The session resumes: two more messages append to the same file.
  writeFileSync(file,
    [line("original first prompt", "m1", "2026-08-01T10:00:00Z"),
     line("original second prompt", "m2", "2026-08-01T10:05:00Z"),
     line("resumed third prompt about sqlite", "m3", "2026-08-05T09:00:00Z"),
     line("resumed fourth prompt about wal mode", "m4", "2026-08-05T09:10:00Z")].join("\n") + "\n");

  const topped = await importNewClaudeCodeSessions(store2, spy, "model", root2);
  assert.equal(topped.toppedUp, 1);
  assert.equal(topped.newSessions, 0);

  const delta = seenContents[1]!;
  assert.match(delta, /resumed third prompt/);
  assert.match(delta, /resumed fourth prompt/);
  assert.doesNotMatch(delta, /original first prompt/, "already-imported messages are not re-sent");
  assert.doesNotMatch(delta, /original second prompt/);

  assert.equal(store2.conversationWatermarks("import:claude-code").get("r1"), "m4", "the watermark advanced");

  // Top-up topics attribute to the session but carry the resume-time ts, so
  // decay treats the activity as current rather than as old as the session.
  const topicEvents = store2.query({ type: "signal.topic", source: "import:claude-code", limit: 100 })
    .filter((e) => (e.provenance as { message_uuid?: string }).message_uuid === "m4");
  assert.ok(topicEvents.length > 0);
  assert.equal(topicEvents[0]!.ts, "2026-08-05T09:00:00.000Z");

  // Pass 4: the top-up itself must not re-import.
  const again = await importNewClaudeCodeSessions(store2, spy, "model", root2);
  assert.equal(again.toppedUp, 0);
  assert.equal(seenContents.length, 2);
});

test("a single new message stays below the top-up threshold until more accrue", async (t) => {
  const root3 = mkdtempSync(join(tmpdir(), "autoimport-threshold-"));
  const dbDir3 = mkdtempSync(join(tmpdir(), "autoimport-threshold-db-"));
  const store3 = new EventStore(join(dbDir3, "test.db"));
  t.after(() => {
    store3.close();
    rmSync(root3, { recursive: true, force: true });
    rmSync(dbDir3, { recursive: true, force: true });
  });

  const dir = join(root3, "-x");
  mkdirSync(dir, { recursive: true });
  const line = (text: string, uuid: string) => JSON.stringify({
    type: "user", uuid, sessionId: "t1", cwd: "/x", timestamp: "2026-08-01T10:00:00Z",
    message: { role: "user", content: text },
  });
  const file = join(dir, "t1.jsonl");
  const base = [line("first", "m1"), line("second", "m2")];
  writeFileSync(file, base.join("\n") + "\n");

  let calls = 0;
  const counting: LlmExtract = async () => {
    calls++;
    return {
      topics: [{
        topic: "t", weight: 0.5, intent: "building", sentiment: "neutral",
        depth: "moderate", category: "technology", entities: [],
      }],
    };
  };

  await importNewClaudeCodeSessions(store3, counting, "model", root3);
  assert.equal(calls, 1);

  // One new message: below the threshold — the 30-min tick must not pay per message.
  writeFileSync(file, [...base, line("third", "m3")].join("\n") + "\n");
  const below = await importNewClaudeCodeSessions(store3, counting, "model", root3);
  assert.equal(below.toppedUp, 0);
  assert.equal(calls, 1, "no extraction for a one-message delta");

  // A second new message crosses it: both come through together.
  writeFileSync(file, [...base, line("third", "m3"), line("fourth", "m4")].join("\n") + "\n");
  const at = await importNewClaudeCodeSessions(store3, counting, "model", root3);
  assert.equal(at.toppedUp, 1);
  assert.equal(calls, 2);
  assert.equal(store3.conversationWatermarks("import:claude-code").get("t1"), "m4");
});
