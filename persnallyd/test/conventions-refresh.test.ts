/**
 * Conventions are derived from a workspace's whole command history, pooled
 * across every local transcript source. The daemon's incremental imports mine
 * only their own batch, so a habit spread thinly over many sessions never
 * clears the noise floor inside any one of them — measured on a real store:
 * 185 npm invocations in one repo, and no npm convention on file.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { newEvent } from "../src/events.js";
import { EventStore } from "../src/store.js";
import { commandsByProjectOnDisk, refreshConventions, refreshVoice } from "../src/voice.js";

const root = mkdtempSync(join(tmpdir(), "conventions-refresh-"));
const store = new EventStore(join(root, "t.db"));
after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });

const PROJECT = "/Users/dev/Projects/thing";
const NONE = { claudeCode: null, cursorDb: null, codex: null };

// ── Claude Code: one session file per batch the daemon would have imported ──
const ccRoot = join(root, "claude-projects");
function ccSession(id: string, commands: string[]): void {
  mkdirSync(join(ccRoot, "-Users-dev-Projects-thing"), { recursive: true });
  const base = { sessionId: id, cwd: PROJECT, timestamp: "2026-08-01T10:00:00Z" };
  const lines = [
    { ...base, type: "user", uuid: `${id}-u1`, message: { role: "user", content: "first prompt" } },
    { ...base, type: "user", uuid: `${id}-u2`, message: { role: "user", content: "second prompt" } },
    ...commands.map((command, i) => ({
      ...base, type: "assistant", uuid: `${id}-a${i}`,
      message: { role: "assistant", content: [{ type: "tool_use", id: `t${i}`, name: "Bash", input: { command } }] },
    })),
  ];
  writeFileSync(join(ccRoot, "-Users-dev-Projects-thing", `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

// ── Codex: a rollout in the same workspace ──
const codexRoot = join(root, "codex-sessions");
function codexRollout(id: string, commands: string[]): void {
  const dir = join(codexRoot, "2026", "08", "20");
  mkdirSync(dir, { recursive: true });
  const ts = "2026-08-20T10:00:00.000Z";
  const lines = [
    { timestamp: ts, type: "session_meta", payload: { id, cwd: PROJECT, timestamp: ts } },
    { timestamp: ts, type: "event_msg", payload: { type: "user_message", message: "one", client_id: "m1" } },
    { timestamp: ts, type: "event_msg", payload: { type: "user_message", message: "two", client_id: "m2" } },
    ...commands.map((cmd) => ({ timestamp: ts, type: "response_item", payload: { type: "custom_tool_call", name: "exec", input: `tools.exec_command({"cmd": ${JSON.stringify(cmd)}})` } })),
  ];
  writeFileSync(join(dir, `rollout-${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

// Two npm invocations per Claude Code session (below MIN_USES=3 in any one
// batch) and two more in a Codex session: only the pooled history shows a habit.
ccSession("s1", ["npm ci", "npm test"]);
ccSession("s2", ["npm run build", "npm test"]);
codexRollout("r1", ["npm ci", "npm test"]);

test("commands are pooled per workspace across sources", () => {
  const by = commandsByProjectOnDisk({ claudeCode: ccRoot, cursorDb: null, codex: codexRoot });
  assert.deepEqual([...by.keys()], [PROJECT]);
  assert.equal(by.get(PROJECT)?.length, 6);
});

test("a habit invisible to every batch appears from the whole history, and replaces the fragments", () => {
  // What per-batch mining would have left behind: a fragment from one session's
  // batch, and a stale contradiction from an older import.
  const fragment = newEvent("signal.style", "import:claude-code",
    { dimension: "convention", pattern: "uses grep", polarity: "does", confidence: 0.6, evidence: "observed in 4 command(s)", basis: "stylometry" },
    { kind: "import", batch: "old", file: "x", project: PROJECT });
  const stale = newEvent("signal.style", "import:codex",
    { dimension: "convention", pattern: "prefers pnpm over npm", polarity: "prefers", confidence: 0.85, evidence: "observed in 40 command(s)", basis: "stylometry" },
    { kind: "import", batch: "older", file: "y", project: PROJECT });
  store.append([fragment, stale]);

  const r = refreshConventions(store, { claudeCode: ccRoot, cursorDb: null, codex: codexRoot });
  assert.equal(r.projects, 1);

  const served = store.voice(PROJECT).items.filter((i) => i.dimension === "convention");
  const patterns = served.map((s) => s.pattern);
  assert.ok(patterns.includes("uses npm"), `pooled 6 npm invocations must yield the habit, got ${JSON.stringify(patterns)}`);
  assert.match(served.find((s) => s.pattern === "uses npm")!.evidence, /observed in 6 command/);
  assert.ok(!patterns.includes("prefers pnpm over npm"), "the stale contradiction from another source's batch is gone");
  assert.ok(!patterns.includes("uses grep"), "the fragment is replaced by the whole-history derivation");
  assert.ok(served.every((s) => s.id), "served conventions carry their event id");
});

test("nothing on disk leaves existing conventions alone rather than wiping them", () => {
  const before = store.voice(PROJECT).items.filter((i) => i.dimension === "convention").length;
  assert.ok(before > 0);
  const r = refreshConventions(store, NONE);
  assert.deepEqual(r, { signals: 0, projects: 0 });
  assert.equal(store.voice(PROJECT).items.filter((i) => i.dimension === "convention").length, before);
});

test("live-observed conventions and tone are never part of the refresh", () => {
  const live = newEvent("signal.style", "mcp:cursor",
    { dimension: "convention", pattern: "prefers merge over rebase", polarity: "prefers", confidence: 0.8, evidence: "seen", basis: "observed" },
    { kind: "mcp", client: "cursor" });
  const tone = newEvent("signal.style", "import:claude-code",
    { dimension: "voice", pattern: "terse", polarity: "does", confidence: 0.9, evidence: "x", basis: "stylometry" },
    { kind: "import", batch: "b", file: "f" });
  store.append([live, tone]);
  refreshConventions(store, { claudeCode: ccRoot, cursorDb: null, codex: codexRoot });
  const patterns = store.voice().items.map((s) => s.pattern);
  assert.ok(patterns.includes("prefers merge over rebase"), "observed basis survives");
  assert.ok(patterns.includes("terse"), "a tone signal has a dimension the conventions refresh does not own");
});

test("refreshVoice pointed at a fixture root reads only that root, not the machine's other history", () => {
  const r = refreshVoice(store, ccRoot, "cli");
  // Six npm invocations live in the Claude Code root alone? No — two sessions
  // hold four; the other two are in the Codex root this call must not read.
  const npm = store.voice(PROJECT).items.find((s) => s.pattern === "uses npm");
  assert.ok(npm, "conventions still refresh from the given root");
  assert.match(npm.evidence, /observed in 4 command/, "only the redirected source was read");
  assert.equal(r.projects, 1);
});

test("an unreadable source is reported and skipped, never fatal", () => {
  const broken = join(root, "broken-codex");
  mkdirSync(join(broken, "2026", "01", "01"), { recursive: true });
  writeFileSync(join(broken, "2026", "01", "01", "rollout-x.jsonl"), "{ not json\n");
  const by = commandsByProjectOnDisk({ claudeCode: ccRoot, cursorDb: null, codex: broken });
  assert.equal(by.get(PROJECT)?.length, 4, "the readable source still contributes");
});
