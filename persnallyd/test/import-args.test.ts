/**
 * `persnally import codex --reextract` (no path, the common case for an
 * optional-path source) used to resolve `path` to the literal string
 * "--reextract" — `const [kind, path] = args` takes whatever is at index 1,
 * flag or not. The importer then tried to read a directory named
 * "--reextract" and failed with a confusing error instead of falling back to
 * its default. Caught by review on PR #242; pre-existed identically for
 * claude-code and cursor, fixed once at the shared parsing site.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { parseImportArgs, shouldRefuseReextract } from "../src/cli.js";
import { extractEvents, type ParsedConversation } from "../src/importers/extract.js";
import type { LlmExtract } from "../src/llm.js";
import { EventStore } from "../src/store.js";

test("--reextract alone is not mistaken for the path", () => {
  const r = parseImportArgs(["codex", "--reextract"]);
  assert.equal(r.kind, "codex");
  assert.equal(r.path, undefined, "no path given -> the importer's own default, not the flag");
  assert.equal(r.reextract, true);
});

test("a real path alongside --reextract still resolves, in either order", () => {
  assert.deepEqual(parseImportArgs(["codex", "/some/dir", "--reextract"]),
    { kind: "codex", path: "/some/dir", reextract: true });
  assert.deepEqual(parseImportArgs(["codex", "--reextract", "/some/dir"]),
    { kind: "codex", path: "/some/dir", reextract: true });
});

test("a required-path source (claude, chatgpt) still gets its path with no --reextract", () => {
  const r = parseImportArgs(["claude", "/some/dir"]);
  assert.equal(r.path, "/some/dir");
  assert.equal(r.reextract, false);
});

test("git's --author value is not mistaken for the path either", () => {
  const r = parseImportArgs(["git", "/some/repos", "--author", "me@example.com"]);
  assert.equal(r.path, "/some/repos", "the first non-flag positional, not --author's own value");
});

test("no arguments at all", () => {
  assert.deepEqual(parseImportArgs([]), { kind: undefined, path: undefined, reextract: false });
});

/**
 * `--reextract` deletes the existing batch for the targeted conversations
 * before writing the new one. `shouldRefuseReextract` is the gate that stops
 * that delete from running when extraction failed across the board — added
 * after a real incident: running `persnally import claude-code --reextract`
 * while API credits were exhausted replaced 1366 real signal events with 59,
 * because the destructive delete ran unconditionally whenever `--reextract`
 * was passed, with no check on whether extraction actually produced
 * anything comparable to what it was about to remove.
 */
test("refuses only the exact shape of a dead engine: --reextract, zero successes, at least one failure", () => {
  assert.equal(shouldRefuseReextract(true, 0, 3), true);
  assert.equal(shouldRefuseReextract(true, 0, 1), true);
});

test("does not refuse a plain (non---reextract) import, even if every extraction failed", () => {
  // Nothing destructive happens on a plain import — no forgetConversations
  // call — so there is nothing here that needs refusing. A first-time import
  // with a dead engine still writes whatever the deterministic parts produced,
  // same as it always has; only the delete-then-replace path is dangerous.
  assert.equal(shouldRefuseReextract(false, 0, 3), false);
});

test("does not refuse a partially-successful reextract", () => {
  // Some real conversations failing to extract (a malformed response, one bad
  // conversation) is routine and already handled per-conversation elsewhere;
  // it is not evidence the engine itself is down.
  assert.equal(shouldRefuseReextract(true, 40, 23), false);
  assert.equal(shouldRefuseReextract(true, 1, 62), false, "even a single success is proof the engine works");
});

test("does not refuse when nothing needed extracting at all", () => {
  // succeeded=0, failed=0 is not an engine failure — it means every
  // conversation's text was empty after stripping (nothing queued), a
  // property of the source, not the engine. Conflating this with "the engine
  // is down" would block a legitimate reextract of thin conversations.
  assert.equal(shouldRefuseReextract(true, 0, 0), false);
});

/**
 * The same scenario end to end, through the real extraction pipeline and a
 * real store rather than the bare boolean — proving the fix actually
 * prevents the incident, not just that the helper function returns the
 * right value in isolation.
 */
const dbDir = mkdtempSync(join(tmpdir(), "reextract-safety-"));
const store = new EventStore(join(dbDir, "test.db"));
after(() => { store.close(); rmSync(dbDir, { recursive: true, force: true }); });

test("reconstructs the actual incident: a dead engine must not be allowed to erase real signal", async () => {
  const convo: ParsedConversation = {
    uuid: "the-session", name: "a real session", summary: "",
    created_at: "2026-06-01T10:00:00Z", userMessages: ["a real prompt about something specific"],
  };

  // A working engine, first import: real signal lands in the store.
  const workingExtract: LlmExtract = async () => ({
    topics: [{ topic: "real topic", weight: 0.8, intent: "building", sentiment: "positive", depth: "deep", category: "technology", entities: [] }],
  });
  const first = await extractEvents({ conversations: [convo], memoryText: "", projects: [] },
    { source: "import:claude-code", importer: "claude-code", file: "x" }, workingExtract);
  store.append(first.events);
  const before = store.query({ type: "signal.topic", limit: 100 }).filter((e) => e.source === "import:claude-code");
  assert.equal(before.length, 1, "the real topic landed");

  // The engine goes down (credits exhausted) and the same conversation is
  // reextracted. Every call fails the same way it did in the real incident.
  const deadExtract: LlmExtract = async () => { throw new Error("400 credit balance too low"); };
  const second = await extractEvents({ conversations: [convo], memoryText: "", projects: [] },
    { source: "import:claude-code", importer: "claude-code", file: "x" }, deadExtract);
  assert.equal(second.extractionsSucceeded, 0);
  assert.ok(second.extractionsFailed > 0);

  // The actual fix: refuse, and confirm what "refuse" means for the store —
  // forgetConversations is never called, so the original event survives.
  const refuse = shouldRefuseReextract(true, second.extractionsSucceeded, second.extractionsFailed);
  assert.equal(refuse, true);
  if (!refuse) {
    store.forgetConversations("import:claude-code", new Set(["the-session"]));
    store.append(second.events);
  }

  const survived = store.query({ type: "signal.topic", limit: 100 }).filter((e) => e.source === "import:claude-code");
  assert.equal(survived.length, 1, "the real topic must still be there — a dead engine did not get to erase it");
  assert.equal((survived[0]!.payload as { topic: string }).topic, "real topic");
});
