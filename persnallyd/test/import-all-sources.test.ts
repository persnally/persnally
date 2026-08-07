/**
 * The key-free onboarding path. Setup used to skip every conversation source
 * when no extraction engine existed and still print "Done" — the user's export
 * sat unread on disk with nothing saying so, and configuring an engine
 * afterwards never went back for it. These tests pin the two properties that
 * fix requires: skipped work is *reported*, and the same import runs later.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import type { ChosenExtractor } from "../src/llm.js";
import { importAllSources } from "../src/setup.js";
import { EventStore } from "../src/store.js";

const root = mkdtempSync(join(tmpdir(), "import-all-"));
process.env.PERSNALLY_DIR = root; // imported_sources lives in config — isolate it
after(() => {
  delete process.env.PERSNALLY_DIR;
  rmSync(root, { recursive: true, force: true });
});

/** Returns both shapes extract.ts asks for; zod strips whichever it isn't parsing. */
const engine = (): ChosenExtractor => ({
  model: "fake",
  label: "fake engine",
  extract: () => Promise.resolve({
    topics: [{
      topic: "event sourcing", weight: 0.8, intent: "building", sentiment: "positive",
      depth: "deep", category: "technology", entities: ["SQLite"],
    }],
    assertions: [{ claim: "builds local-first tools", kind: "behavior", confidence: 0.8, evidence: "exports" }],
  }),
});

let downloads: string;
let store: EventStore;
let n = 0;

beforeEach(() => {
  // Fresh config + store per test: imported_sources is what makes this idempotent,
  // so leaking it between cases would mask exactly the behavior under test.
  n += 1;
  writeFileSync(join(root, "config.json"), "{}");
  downloads = join(root, `downloads-${n}`);
  mkdirSync(join(downloads, "claude-export"), { recursive: true });
  writeFileSync(
    join(downloads, "claude-export", "conversations.json"),
    JSON.stringify([{
      uuid: "c1", name: "on databases", created_at: "2026-01-01T00:00:00Z",
      chat_messages: [{ sender: "human", text: "how do I model an append-only log in SQLite?" }],
    }]),
  );
  store = new EventStore(join(root, `store-${n}.db`));
});

describe("without an extraction engine", () => {
  test("nothing is imported, and the skipped source is named rather than silently dropped", async () => {
    const r = await importAllSources(store, null, { downloadsDir: downloads, transcriptsDir: join(root, "none") });

    assert.equal(r.events, 0);
    assert.deepEqual(r.imported, []);
    assert.equal(r.skipped.length, 1, "the export on disk must be reported, not ignored");
    assert.match(r.skipped[0]!, /claude export/);
    assert.match(r.skipped[0]!, /claude-export/, "names the actual path so the user can find it");
    assert.equal(store.stats().total, 0);
    store.close();
  });

  test("the source is NOT marked imported, so a later run with an engine still picks it up", async () => {
    await importAllSources(store, null, { downloadsDir: downloads, transcriptsDir: join(root, "none") });

    // The bug this guards: marking it consumed on the engine-less pass would
    // strand that history forever once an engine appeared.
    const second = await importAllSources(store, engine(), { downloadsDir: downloads, transcriptsDir: join(root, "none") });

    assert.ok(second.events > 0, "the previously skipped export imports once an engine exists");
    assert.deepEqual(second.skipped, []);
    assert.equal(second.imported.length, 1);
    store.close();
  });
});

describe("with an extraction engine", () => {
  test("imports the export and reports what it did", async () => {
    const seen: string[] = [];
    const r = await importAllSources(store, engine(), {
      downloadsDir: downloads,
      transcriptsDir: join(root, "none"),
      onProgress: (l) => seen.push(l),
    });

    assert.ok(r.events > 0);
    assert.deepEqual(r.skipped, []);
    assert.match(r.imported[0]!, /claude export/);
    assert.ok(seen.some((l) => /Importing/.test(l)), "progress is reported as work happens");
    assert.ok(store.stats().total > 0);
    store.close();
  });

  test("re-running is a no-op — an already-imported source is never charged for twice", async () => {
    const first = await importAllSources(store, engine(), { downloadsDir: downloads, transcriptsDir: join(root, "none") });
    const after1 = store.stats().total;

    const second = await importAllSources(store, engine(), { downloadsDir: downloads, transcriptsDir: join(root, "none") });

    assert.ok(first.events > 0);
    assert.equal(second.events, 0, "no new events");
    assert.deepEqual(second.imported, []);
    assert.equal(store.stats().total, after1, "the store is unchanged");
    store.close();
  });

  test("derived views are rebuilt, so the portrait sees the new signals immediately", async () => {
    await importAllSources(store, engine(), { downloadsDir: downloads, transcriptsDir: join(root, "none") });

    assert.ok(store.topics().length > 0, "rebuild() ran — topics are queryable without a second call");
    store.close();
  });
});
