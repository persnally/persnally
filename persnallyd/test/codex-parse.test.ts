import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { DEFAULT_MAX_SESSIONS, parseCodexTranscripts } from "../src/importers/codex.js";

/**
 * The Codex rollout format has no published schema — every shape asserted
 * here was read out of real `~/.codex/sessions/**\/*.jsonl` files on a machine
 * that has used Codex (CLI, desktop, and IDE all write the same format), not
 * from documentation. Two things the real data forced that a hand-written
 * fixture would never have surfaced on its own: a "guardian" safety-review
 * subthread whose `user_message` turns are the parent transcript being fed
 * in for review, not the human — and a `custom_tool_call`'s `input` being a
 * JS snippet the model wrote, not a JSON object.
 */

const root = mkdtempSync(join(tmpdir(), "codex-import-"));
after(() => rmSync(root, { recursive: true, force: true }));

const lines = (...entries: unknown[]) => entries.map((e) => JSON.stringify(e)).join("\n") + "\n";

const sessionMeta = (id: string, cwd: string, ts: string, extra: Record<string, unknown> = {}) => ({
  timestamp: ts, type: "session_meta",
  payload: { id, cwd, timestamp: ts, originator: "Codex CLI", ...extra },
});
const userMsg = (message: string) => ({ type: "event_msg", payload: { type: "user_message", message } });
const agentMsg = (message: string) => ({ type: "event_msg", payload: { type: "agent_message", message } });
const execCall = (input: string) => ({ type: "response_item", payload: { type: "custom_tool_call", name: "exec", input } });

function rolloutDir(base: string): string {
  const dir = join(base, "2026", "08", "20");
  mkdirSync(dir, { recursive: true });
  return dir;
}

test("real rollout shapes: user/agent turns, project, and JS-embedded exec commands", () => {
  const dir = rolloutDir(join(root, "real-shapes"));
  writeFileSync(join(dir, "rollout-a.jsonl"), lines(
    sessionMeta("s1", "/Users/dev/Projects/widget", "2026-08-20T10:00:00.000Z"),
    userMsg("add a settings sheet to the widget view"),
    agentMsg("Sure — here's the plan."),
    execCall('const r = await Promise.all([\n  tools.exec_command({"cmd":"npm test","workdir":"/x"}),\n]);'),
    userMsg("also run the type checker"),
    execCall('tools.exec_command({"cmd":"tsc --noEmit","workdir":"/x","yield_time_ms":5000})'),
    agentMsg("Both pass."),
  ));

  const { parsed, sessionsFound, sessionsDropped } = parseCodexTranscripts(join(root, "real-shapes"));
  assert.equal(sessionsFound, 1);
  assert.equal(sessionsDropped, 0);
  assert.equal(parsed.conversations.length, 1);

  const c = parsed.conversations[0]!;
  assert.equal(c.uuid, "s1");
  assert.equal(c.project, "/Users/dev/Projects/widget");
  assert.deepEqual(c.userMessages, ["add a settings sheet to the widget view", "also run the type checker"]);
  assert.deepEqual(c.assistantMessages, ["Sure — here's the plan.", "Both pass."]);
  assert.deepEqual(c.toolCommands, ["npm test", "tsc --noEmit"],
    "commands are extracted from a JS snippet, not a JSON object — there is no clean parse to do here");
});

test("a subagent thread's turns are not credited to the user", () => {
  const dir = rolloutDir(join(root, "subagent"));
  writeFileSync(join(dir, "rollout-guardian.jsonl"), lines(
    sessionMeta("guardian-1", "/Users/dev/Projects/widget", "2026-08-20T10:05:00.000Z", { thread_source: "subagent" }),
    userMsg("The following is the Codex agent history whose request action you are assessing..."),
    agentMsg('{"risk_level":"low","outcome":"allow"}'),
    userMsg("The following is the Codex agent history added since your last approval assessment..."),
    agentMsg('{"risk_level":"low","outcome":"allow"}'),
  ));

  const { parsed, sessionsFound } = parseCodexTranscripts(join(root, "subagent"));
  assert.equal(sessionsFound, 0, "a subagent thread never becomes a 'found' session — filtered at the source");
  assert.equal(parsed.conversations.length, 0,
    "a guardian/safety subthread must be excluded — its 'user' turns are the parent transcript, not the human");
});

test("synthetic user-role text is dropped, not imported as something the user said", () => {
  const dir = rolloutDir(join(root, "injected"));
  writeFileSync(join(dir, "rollout-b.jsonl"), lines(
    sessionMeta("s2", "/Users/dev/Projects/widget", "2026-08-20T10:10:00.000Z"),
    userMsg("<recommended_plugins>\nHere is a list of plugins...\n</recommended_plugins>"),
    userMsg("<environment_context>\n  <cwd>/x</cwd>\n</environment_context>"),
    userMsg("\n# Files mentioned by the user:\n\n## some quoted thing: /path/to/file"),
    userMsg("a genuine question"),
    userMsg("a second genuine question"),
    agentMsg("an answer"),
  ));

  const { parsed } = parseCodexTranscripts(join(root, "injected"));
  assert.deepEqual(parsed.conversations[0]!.userMessages, ["a genuine question", "a second genuine question"]);
});

test("a below-threshold session (one real message) is dropped as noise", () => {
  const dir = rolloutDir(join(root, "thin"));
  writeFileSync(join(dir, "rollout-c.jsonl"), lines(
    sessionMeta("s3", "/Users/dev/Projects/widget", "2026-08-20T10:15:00.000Z"),
    userMsg("only one message"),
    agentMsg("ok"),
  ));

  const { parsed, sessionsFound } = parseCodexTranscripts(join(root, "thin"));
  assert.equal(sessionsFound, 0, "same MIN_USER_MESSAGES semantics as claude-code.ts's own sessionsFound");
  assert.equal(parsed.conversations.length, 0);
});

test("a session with no cwd carries no project, rather than a guessed one", () => {
  const dir = rolloutDir(join(root, "no-cwd"));
  writeFileSync(join(dir, "rollout-d.jsonl"), lines(
    { timestamp: "2026-08-20T10:20:00.000Z", type: "session_meta", payload: { id: "s4", timestamp: "2026-08-20T10:20:00.000Z" } },
    userMsg("one"), userMsg("two"), agentMsg("ok"),
  ));

  const { parsed } = parseCodexTranscripts(join(root, "no-cwd"));
  assert.equal(parsed.conversations[0]!.project, undefined);
});

test("session_index.jsonl's thread_name is used when present, generated name otherwise", () => {
  const base = join(root, "named");
  const dir = rolloutDir(base);
  writeFileSync(join(dir, "rollout-e.jsonl"), lines(
    sessionMeta("s5", "/Users/dev/Projects/widget", "2026-08-20T10:25:00.000Z"),
    userMsg("one"), userMsg("two"),
  ));
  writeFileSync(join(dir, "rollout-f.jsonl"), lines(
    sessionMeta("s6", "/Users/dev/Projects/widget", "2026-08-20T10:26:00.000Z"),
    userMsg("three"), userMsg("four"),
  ));
  // session_index.jsonl is a sibling of the sessions dir (~/.codex/session_index.jsonl
  // next to ~/.codex/sessions/), not inside it.
  writeFileSync(join(root, "session_index.jsonl"), lines({ id: "s5", thread_name: "Build the widget settings sheet" }));

  const { parsed } = parseCodexTranscripts(base);
  const byId = new Map(parsed.conversations.map((c) => [c.uuid, c.name]));
  assert.equal(byId.get("s5"), "Build the widget settings sheet");
  assert.match(byId.get("s6")!, /^Codex session in widget$/, "no index entry -> falls back to the generated name");
});

test("a rollout file that fails to even read does not abort the sessions around it", () => {
  const dir = rolloutDir(join(root, "malformed"));
  writeFileSync(join(dir, "rollout-good.jsonl"), lines(
    sessionMeta("good", "/Users/dev/Projects/widget", "2026-08-20T10:30:00.000Z"),
    userMsg("first message"), userMsg("second message"),
  ));
  // A file `readFileSync` cannot open: no per-field shape guard inside
  // parseSession can catch this, since it throws before a single byte of JSON
  // is parsed — only a boundary around the whole call can. Modeled on a real
  // failure class: a rollout being rotated or permission-changed by Codex
  // between listing the directory and reading the file. (A directory literally
  // named `*.jsonl` was tried first and does not reach this path at all —
  // findRolloutFiles filters by `Dirent.isFile()` before parseSession ever
  // sees it, so that fixture proved nothing.)
  const unreadable = join(dir, "rollout-unreadable.jsonl");
  writeFileSync(unreadable, "irrelevant");
  chmodSync(unreadable, 0o000);
  after(() => { try { chmodSync(unreadable, 0o644); } catch { /* already gone */ } });

  const { parsed } = parseCodexTranscripts(join(root, "malformed"));
  assert.ok(parsed.conversations.some((c) => c.uuid === "good"),
    "a file that fails outright must not take a well-formed session down with it");
});

test("sessions beyond the cap are dropped, most-recently-created kept", () => {
  const dir = rolloutDir(join(root, "capped"));
  for (let i = 0; i < 5; i++) {
    writeFileSync(join(dir, `rollout-${i}.jsonl`), lines(
      sessionMeta(`s-${i}`, "/Users/dev/Projects/widget", `2026-08-20T${String(10 + i).padStart(2, "0")}:00:00.000Z`),
      userMsg("hi"), userMsg("again"),
    ));
  }

  const { parsed, sessionsFound, sessionsDropped } = parseCodexTranscripts(join(root, "capped"), 2);
  assert.equal(sessionsFound, 5);
  assert.equal(sessionsDropped, 3);
  assert.deepEqual(parsed.conversations.map((c) => c.uuid).sort(), ["s-3", "s-4"],
    "the two most recently created, not the two written first");
});

test("a missing sessions directory is a clear error, not a stack trace", () => {
  assert.throws(() => parseCodexTranscripts(join(root, "does-not-exist")), /No Codex transcripts/);
});

test("the cap is a real constant", () => {
  assert.equal(DEFAULT_MAX_SESSIONS, 200);
});
