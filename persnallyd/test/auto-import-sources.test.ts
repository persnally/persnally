/**
 * `runAutoImportSources` is the part of daemon.ts's auto-import tick that
 * genuinely changed when Cursor and Codex got incremental top-up: what used
 * to be one call to `importNewClaudeCodeSessions` became a loop over three
 * sources sharing one engine. The short-circuit — stop at the first engine
 * failure rather than pay fail-fast's cost three times over — is the whole
 * point, and it's tested here with fake sources so it doesn't need a real
 * extraction engine or network access.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { runAutoImportSources, type AutoImportSource } from "../src/daemon.js";
import type { IncrementalImportResult } from "../src/importers/incremental.js";
import { EventStore } from "../src/store.js";

const dbDir = mkdtempSync(join(tmpdir(), "auto-import-sources-"));
const store = new EventStore(join(dbDir, "test.db"));
after(() => { store.close(); rmSync(dbDir, { recursive: true, force: true }); });

const ok = (events: number): IncrementalImportResult =>
  ({ newConversations: 1, toppedUp: 0, events, skipped: 0, engineFailed: false });
const dead = (newConversations: number): IncrementalImportResult =>
  ({ newConversations, toppedUp: 0, events: 0, skipped: 0, engineFailed: true });

function source(label: string, result: IncrementalImportResult): AutoImportSource & { calls: number } {
  const s = { label, calls: 0, run: async () => { s.calls++; return result; } };
  return s;
}

test("every source runs and their events aggregate when none fail", async () => {
  const a = source("A", ok(3));
  const b = source("B", ok(5));
  const c = source("C", ok(2));

  const outcome = await runAutoImportSources([a, b, c], store, async () => ({}), "model");
  assert.equal(outcome.totalEvents, 10);
  assert.equal(outcome.engineFailedAt, null);
  assert.equal(a.calls, 1); assert.equal(b.calls, 1); assert.equal(c.calls, 1);
});

test("the first source failing stops the rest — a dead engine is dead for everyone", async () => {
  const a = source("A", dead(4));
  const b = source("B", ok(5));
  const c = source("C", ok(2));

  const outcome = await runAutoImportSources([a, b, c], store, async () => ({}), "model");
  assert.equal(outcome.engineFailedAt, "A");
  assert.equal(outcome.itemsLeftUnimported, 4);
  assert.equal(outcome.totalEvents, 0, "nothing from A counts, and B/C never got the chance to contribute");
  assert.equal(a.calls, 1);
  assert.equal(b.calls, 0, "B must never be called once A proved the engine is down");
  assert.equal(c.calls, 0, "neither must C");
});

test("a later source failing still counts the earlier ones' events, and stops before the rest", async () => {
  const a = source("A", ok(3));
  const b = source("B", dead(7));
  const c = source("C", ok(2));

  const outcome = await runAutoImportSources([a, b, c], store, async () => ({}), "model");
  assert.equal(outcome.engineFailedAt, "B");
  assert.equal(outcome.itemsLeftUnimported, 7);
  assert.equal(outcome.totalEvents, 3, "A's events, which landed before the engine proved dead, still count");
  assert.equal(a.calls, 1);
  assert.equal(b.calls, 1);
  assert.equal(c.calls, 0, "C never runs once B shows the engine is down");
});

test("a source with nothing to do (zero events, not a failure) doesn't stop the loop", async () => {
  const a = source("A", { newConversations: 0, toppedUp: 0, events: 0, skipped: 3, engineFailed: false });
  const b = source("B", ok(4));

  const outcome = await runAutoImportSources([a, b], store, async () => ({}), "model");
  assert.equal(outcome.engineFailedAt, null);
  assert.equal(outcome.totalEvents, 4);
  assert.equal(b.calls, 1);
});
