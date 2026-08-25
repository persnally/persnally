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
const userMsg = (message: string, clientId?: string) =>
  ({ type: "event_msg", payload: { type: "user_message", message, ...(clientId ? { client_id: clientId } : {}) } });
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

/**
 * The seven tests below were added after a five-dimension adversarial swarm
 * review of this importer found real defects and coverage gaps — each one
 * verified against real ~/.codex/sessions data on the reviewing machine
 * before being fixed, not assumed from the finding alone.
 */

test("the user's real request is salvaged from inside the attachment wrapper, not dropped with it", () => {
  // The exact shape found on a real machine: pasting reference material,
  // then saying what to do with it, produced a user_message that starts
  // with the synthetic "Files mentioned" header and ends with the user's
  // own freshly-typed instruction. The earlier version of this importer
  // dropped the whole message — instruction included — because it only
  // recognized the header as a prefix, not the request as a suffix.
  const dir = rolloutDir(join(root, "salvage"));
  const wrapped = "\n# Files mentioned by the user:\n\n## Some Document (v0.1): "
    + "/Users/dev/.codex/attachments/abc/pasted-text.txt\n\n## My request for Codex:\n"
    + "help me build this in the best possible way";
  writeFileSync(join(dir, "rollout-g.jsonl"), lines(
    sessionMeta("s7", "/Users/dev/Projects/widget", "2026-08-20T10:35:00.000Z"),
    userMsg(wrapped),
    userMsg("a second real message so the session clears the noise floor"),
  ));

  const { parsed } = parseCodexTranscripts(join(root, "salvage"));
  assert.deepEqual(parsed.conversations[0]!.userMessages, [
    "help me build this in the best possible way",
    "a second real message so the session clears the noise floor",
  ]);
});

test("null as a JSONL line does not sink the whole session, only itself", () => {
  // JSON.parse("null") succeeds and returns null — the per-line try/catch
  // around JSON.parse does not fire, and accessing .type on the result used
  // to throw uncaught, which the file-level try/catch in
  // parseCodexTranscripts then turned into dropping the entire session.
  const dir = rolloutDir(join(root, "null-line"));
  const raw = [
    JSON.stringify(sessionMeta("s8", "/Users/dev/Projects/widget", "2026-08-20T10:40:00.000Z")),
    JSON.stringify(userMsg("first real message")),
    "null",
    JSON.stringify(userMsg("second real message, after the null line")),
  ].join("\n") + "\n";
  writeFileSync(join(dir, "rollout-h.jsonl"), raw);

  const { parsed } = parseCodexTranscripts(join(root, "null-line"));
  assert.deepEqual(parsed.conversations[0]?.userMessages,
    ["first real message", "second real message, after the null line"],
    "a null line is skipped like any other unparseable line, not fatal to the session");
});

test("an unreadable subdirectory does not sink sessions in sibling directories", () => {
  // readdirSync(root, { recursive: true }) throws on the FIRST unreadable
  // nested directory anywhere in the tree and returns nothing at all — not
  // a partial list — which would silently zero out an entire import from
  // one bad `<year>/<month>/<day>` folder among years of readable ones.
  const base = join(root, "bad-subdir");
  const goodDir = rolloutDir(join(base, "good-branch"));
  writeFileSync(join(goodDir, "rollout-good.jsonl"), lines(
    sessionMeta("good", "/Users/dev/Projects/widget", "2026-08-20T10:45:00.000Z"),
    userMsg("one"), userMsg("two"),
  ));
  const badDir = join(base, "bad-branch", "2026", "08", "20");
  mkdirSync(badDir, { recursive: true });
  writeFileSync(join(badDir, "rollout-unreachable.jsonl"), lines(
    sessionMeta("unreachable", "/Users/dev/Projects/widget", "2026-08-20T10:46:00.000Z"),
    userMsg("one"), userMsg("two"),
  ));
  chmodSync(join(base, "bad-branch"), 0o000);
  after(() => { try { chmodSync(join(base, "bad-branch"), 0o755); } catch { /* already gone */ } });

  const { parsed } = parseCodexTranscripts(base);
  assert.ok(parsed.conversations.some((c) => c.uuid === "good"),
    "one unreadable directory elsewhere in the tree must not zero out the whole import");
});

test("a session with no timestamp anywhere gets the epoch, not the moment it happened to be imported", () => {
  // createdAtMs stays 0 when nothing in the file ever yields a parseable
  // timestamp. Falling back to "now" would hand a stale or
  // malformed-metadata session false maximum recency in the decay-weighted
  // interest graph, silently and with no warning.
  const dir = rolloutDir(join(root, "no-timestamp"));
  writeFileSync(join(dir, "rollout-i.jsonl"), lines(
    { type: "session_meta", payload: { id: "s9", cwd: "/Users/dev/Projects/widget" } },
    userMsg("one"), userMsg("two"),
  ));

  const { parsed } = parseCodexTranscripts(join(root, "no-timestamp"));
  assert.match(parsed.conversations[0]!.created_at, /^1970-01-01T/,
    "no timestamp found anywhere -> the epoch, an honest 'unknown', not a fabricated 'now'");
});

test("multiple exec_command calls in one input, including quoted and backslash-escaped commands, are all recovered", () => {
  const dir = rolloutDir(join(root, "multi-exec"));
  const input = 'const r = await Promise.all([\n'
    + '  tools.exec_command({"cmd":"git commit -m \\"fix: handle the edge case\\"","workdir":"/x"}),\n'
    + '  tools.exec_command({"cmd":"echo \\"a\\\\\\\\b\\"","workdir":"/x"}),\n'
    + ']);';
  writeFileSync(join(dir, "rollout-j.jsonl"), lines(
    sessionMeta("s10", "/Users/dev/Projects/widget", "2026-08-20T10:50:00.000Z"),
    userMsg("one"), userMsg("two"),
    { type: "response_item", payload: { type: "custom_tool_call", name: "exec", input } },
  ));

  const { parsed } = parseCodexTranscripts(join(root, "multi-exec"));
  assert.deepEqual(parsed.conversations[0]!.toolCommands, [
    'git commit -m "fix: handle the edge case"',
    'echo "a\\\\b"',
  ], "both calls in the same Promise.all recovered, with embedded quotes and a literal backslash intact");
});

test("a malformed line in session_index.jsonl does not break the fallback to a generated name", () => {
  const base = join(root, "bad-index");
  const dir = rolloutDir(base);
  writeFileSync(join(dir, "rollout-k.jsonl"), lines(
    sessionMeta("s11", "/Users/dev/Projects/widget", "2026-08-20T10:55:00.000Z"),
    userMsg("one"), userMsg("two"),
  ));
  // A line that is invalid JSON, and a line that is valid JSON but not an
  // object (loadThreadNames destructures `{ id, thread_name }` off it) —
  // sandwiched around a genuinely usable entry for a DIFFERENT session, so
  // the test also proves the malformed lines don't block real entries after them.
  writeFileSync(join(root, "session_index.jsonl"),
    "{not valid json\n" + JSON.stringify(null) + "\n" + JSON.stringify({ id: "other-session", thread_name: "Unrelated" }) + "\n");

  const { parsed } = parseCodexTranscripts(base);
  assert.match(parsed.conversations[0]!.name, /^Codex session in widget$/,
    "a session_index.jsonl with malformed lines must not crash the import — this session just gets its generated name");
});

test("lastMessageId captures the last kept user message's client_id, a watermark for future top-up", () => {
  // Nothing consumes this yet — no importer here does incremental top-up of a
  // resumed session (matching cursor.ts, which never sets it either). This
  // only proves the field is captured correctly, the same way
  // claude-code.ts's own messageIds/lastMessageId works, so a future top-up
  // implementation does not need every session re-extracted from scratch to
  // backfill watermarks it could have had all along.
  const dir = rolloutDir(join(root, "watermark"));
  writeFileSync(join(dir, "rollout-n.jsonl"), lines(
    sessionMeta("s12", "/Users/dev/Projects/widget", "2026-08-20T11:10:00.000Z"),
    userMsg("first", "client-a"),
    userMsg("second", "client-b"),
  ));
  const { parsed } = parseCodexTranscripts(join(root, "watermark"));
  assert.equal(parsed.conversations[0]!.lastMessageId, "client-b",
    "the LAST kept message's client_id, not the first");
});

test("a message dropped by salvageUserText does not become the watermark", () => {
  const dir = rolloutDir(join(root, "watermark-dropped"));
  writeFileSync(join(dir, "rollout-o.jsonl"), lines(
    sessionMeta("s13", "/Users/dev/Projects/widget", "2026-08-20T11:15:00.000Z"),
    userMsg("first real message", "client-real-1"),
    userMsg("second real message", "client-real-2"),
    userMsg("<environment_context>\n  <cwd>/x</cwd>\n</environment_context>", "client-injected"),
  ));
  const { parsed } = parseCodexTranscripts(join(root, "watermark-dropped"));
  assert.equal(parsed.conversations[0]!.lastMessageId, "client-real-2",
    "the injected message's client_id must not become the watermark — it was never actually imported");
});

test("no client_id anywhere leaves the watermark unset, not a fabricated one", () => {
  const dir = rolloutDir(join(root, "watermark-none"));
  writeFileSync(join(dir, "rollout-p.jsonl"), lines(
    sessionMeta("s14", "/Users/dev/Projects/widget", "2026-08-20T11:20:00.000Z"),
    userMsg("one"), userMsg("two"),
  ));
  const { parsed } = parseCodexTranscripts(join(root, "watermark-none"));
  assert.equal(parsed.conversations[0]!.lastMessageId, undefined);
});

test("a resumed session (two session_meta lines) keeps the first cwd/id/timestamp, and isSubagent stays true once set", () => {
  // Codex resuming a thread across app launches is ordinary usage that would
  // append a second session_meta line mid-file. Locking in this file's actual
  // current behavior: first non-empty id/cwd/timestamp wins, and a subagent
  // flag seen on ANY meta line excludes the whole session (never reset).
  const dir = rolloutDir(join(root, "resumed"));
  writeFileSync(join(dir, "rollout-l.jsonl"), lines(
    sessionMeta("first-id", "/Users/dev/Projects/first-project", "2026-08-20T11:00:00.000Z"),
    userMsg("before resuming"),
    sessionMeta("second-id", "/Users/dev/Projects/second-project", "2026-08-20T12:00:00.000Z"),
    userMsg("after resuming"),
  ));

  const { parsed } = parseCodexTranscripts(join(root, "resumed"));
  const c = parsed.conversations[0]!;
  assert.equal(c.uuid, "first-id", "the first session_meta's id wins");
  assert.equal(c.project, "/Users/dev/Projects/first-project", "the first session_meta's cwd wins");
  assert.deepEqual(c.userMessages, ["before resuming", "after resuming"]);

  const dir2 = rolloutDir(join(root, "resumed-subagent"));
  writeFileSync(join(dir2, "rollout-m.jsonl"), lines(
    sessionMeta("normal-first", "/Users/dev/Projects/widget", "2026-08-20T11:05:00.000Z"),
    userMsg("looks normal at first"),
    sessionMeta("normal-first", "/Users/dev/Projects/widget", "2026-08-20T11:06:00.000Z", { thread_source: "subagent" }),
    userMsg("but becomes a subagent thread partway through"),
  ));
  const { parsed: parsed2 } = parseCodexTranscripts(join(root, "resumed-subagent"));
  assert.equal(parsed2.conversations.length, 0,
    "isSubagent, once set by any session_meta line, is never cleared by an earlier-looking one");
});
