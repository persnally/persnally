import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";
import { newEvent } from "../src/events.js";
import { EventStore } from "../src/store.js";

const run = promisify(execFile);
const dir = mkdtempSync(join(tmpdir(), "context-test-"));
const dbPath = join(dir, "persnally.db");
const CLI = join(import.meta.dirname, "..", "src", "cli.js");
const env = { ...process.env, PERSNALLY_DIR: dir };

after(() => rmSync(dir, { recursive: true, force: true }));

test("context --hook emits a valid SessionStart envelope and records a read", async () => {
  const store = new EventStore(dbPath);
  store.append([newEvent(
    "signal.topic",
    "cli",
    { topic: "Rust async", weight: 0.8, intent: "learning", sentiment: "positive", depth: "deep", category: "technology", entities: ["Rust"] },
    { kind: "local", surface: "cli" },
  )]);
  store.rebuild();
  const before = store.stats().byType["context.read"] ?? 0;
  store.close();

  const { stdout } = await run("node", [CLI, "context", "--hook"], { env });
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(parsed.hookSpecificOutput.additionalContext, /Rust async/);

  const store2 = new EventStore(dbPath);
  assert.equal(store2.stats().byType["context.read"] ?? 0, before + 1, "a context.read event was recorded");
  store2.close();
});

test("context --hook injects the loop instructions; plain context stays clean", async () => {
  const { stdout: hooked } = await run("node", [CLI, "context", "--hook"], { env });
  const ctx = JSON.parse(hooked).hookSpecificOutput.additionalContext as string;
  assert.match(ctx, /call persnally_ask first/, "hook teaches the ask loop");
  assert.match(ctx, /call persnally_track/, "hook keeps the end-of-session track instruction");

  const { stdout: plain } = await run("node", [CLI, "context"], { env });
  assert.doesNotMatch(plain, /persnally_ask/, "plain context output carries no tool instructions");
  assert.doesNotMatch(plain, /persnally_track/);
});

test("context --hook emits nothing when the store is empty", async () => {
  const emptyDir = mkdtempSync(join(tmpdir(), "context-empty-"));
  try {
    const { stdout } = await run("node", [CLI, "context", "--hook"], { env: { ...process.env, PERSNALLY_DIR: emptyDir } });
    assert.equal(stdout.trim(), "", "no envelope when there is nothing to inject");
  } finally {
    rmSync(emptyDir, { recursive: true, force: true });
  }
});

test("a hook read is attributed to the client it injects into, not to the CLI", async () => {
  // The highest-volume read channel — every Claude Code session — was recorded
  // as `cli`, so the access matrix attributed it to nobody and the north-star
  // metric counted it as the owner reading themselves.
  const d = mkdtempSync(join(tmpdir(), "context-attr-"));
  try {
    const store = new EventStore(join(d, "persnally.db"));
    store.append([newEvent("signal.topic", "cli",
      { topic: "attribution", weight: 0.8, intent: "building", sentiment: "positive", depth: "deep", category: "technology", entities: [] },
      { kind: "local", surface: "cli" })]);
    store.rebuild();
    store.close();

    const hookEnv = { ...process.env, PERSNALLY_DIR: d };
    await run("node", [CLI, "context", "--hook", "--client=claude-code"], { env: hookEnv });
    await run("node", [CLI, "context"], { env: hookEnv }); // an owner read, for contrast

    const s2 = new EventStore(join(d, "persnally.db"));
    const reads = s2.query({ type: "context.read", limit: 20 });
    const bySource = new Map(reads.map((e) => [e.source, e.provenance as Record<string, unknown>]));

    assert.ok(bySource.has("hook:claude-code"), "the hook read was not attributed to the client");
    assert.equal(bySource.get("hook:claude-code")?.surface, "hook", "the mechanism is still recorded honestly");
    assert.equal(bySource.get("hook:claude-code")?.client, "claude-code");
    assert.ok(bySource.has("cli"), "a manual context read is still the owner's own");
    s2.close();
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("an already-installed hook, passing no --client, still attributes correctly", async () => {
  // Hooks installed before this change pass only --hook; they must not silently
  // keep writing unattributed reads.
  const d = mkdtempSync(join(tmpdir(), "context-legacy-"));
  try {
    const store = new EventStore(join(d, "persnally.db"));
    store.append([newEvent("signal.topic", "cli",
      { topic: "legacy hook", weight: 0.8, intent: "building", sentiment: "positive", depth: "deep", category: "technology", entities: [] },
      { kind: "local", surface: "cli" })]);
    store.rebuild();
    store.close();

    await run("node", [CLI, "context", "--hook"], { env: { ...process.env, PERSNALLY_DIR: d } });
    const s2 = new EventStore(join(d, "persnally.db"));
    assert.deepEqual(s2.query({ type: "context.read", limit: 5 }).map((e) => e.source), ["hook:claude-code"]);
    s2.close();
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
