/**
 * Re-extraction. Importing is deliberately idempotent — already-seen
 * conversations are skipped by uuid — which is right for cost but meant the
 * first import's quality was permanent: a better prompt or model could never be
 * applied to history already on file. Stamping the pipeline version is what
 * lets a later run identify what's worth re-running; `forgetConversations` is
 * what makes the re-run replace rather than double.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { newEvent } from "../src/events.js";
import { EXTRACTOR_VERSION, extractEvents, type ParsedExport } from "../src/importers/extract.js";
import type { LlmExtract } from "../src/llm.js";
import { EventStore } from "../src/store.js";

const dir = mkdtempSync(join(tmpdir(), "reextract-"));
after(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
const freshStore = () => new EventStore(join(dir, `s${++n}.db`));

const parsed = (): ParsedExport => ({
  conversations: [
    { uuid: "c1", name: "on databases", summary: "", created_at: "2026-08-01T00:00:00Z",
      userMessages: ["how do I model an append-only event log in sqlite"] },
    { uuid: "c2", name: "on rust", summary: "", created_at: "2026-08-02T00:00:00Z",
      userMessages: ["what is the borrow checker actually doing here"] },
  ],
  memoryText: "",
  projects: [],
});

/** Names its topics after the "version" that produced them, so a re-extraction
    is visible in the store rather than merely counted. */
const engineV = (label: string): LlmExtract => () => Promise.resolve({
  topics: [{
    topic: `topic from ${label}`, weight: 0.7, intent: "building", sentiment: "neutral",
    depth: "moderate", category: "technology", entities: [],
  }],
  assertions: [],
});

const importOnce = (store: EventStore, label: string) =>
  extractEvents(parsed(), { source: "import:claude", importer: "claude", file: "conversations.json" },
    engineV(label), "model");

describe("the batch records which extractor produced it", () => {
  test("system.import carries the current extractor version", async () => {
    const store = freshStore();
    const { events } = await importOnce(store, "v1");
    store.append(events);

    const marker = store.query({ type: "system.import", limit: 10 })[0];
    assert.ok(marker);
    assert.equal((marker.payload as { extractor_version?: number }).extractor_version, EXTRACTOR_VERSION);
    store.close();
  });

  test("importBatchVersions reports batches, and null for anything imported before versioning", async () => {
    const store = freshStore();
    const { events } = await importOnce(store, "v1");
    store.append(events);
    // A legacy batch: same shape, no extractor_version — exactly what a store
    // written by an earlier release contains.
    store.append([newEvent("system.import", "system",
      { importer: "claude", batch: "legacy-batch", events: 3 },
      { kind: "import", batch: "legacy-batch", file: "conversations.json" })]);

    const versions = store.importBatchVersions("claude");

    assert.equal(versions.length, 2);
    const legacy = versions.find((v) => v.batch === "legacy-batch");
    assert.equal(legacy?.version, null, "a pre-versioning batch is always a re-extraction candidate");
    assert.ok(versions.some((v) => v.version === EXTRACTOR_VERSION));
    store.close();
  });
});

describe("re-extraction replaces instead of doubling", () => {
  test("forgetConversations drops exactly the prior events for those conversations", async () => {
    const store = freshStore();
    const first = await importOnce(store, "v1");
    store.append(first.events);
    store.rebuild();
    const topicsBefore = store.query({ type: "signal.topic", source: "import:claude", limit: 100 });
    assert.equal(topicsBefore.length, 2, "one topic per conversation");

    // The re-extraction flow: extract with the better engine, then drop the old.
    const second = await importOnce(store, "v2");
    const removed = store.forgetConversations("import:claude", new Set(["c1", "c2"]));
    store.append(second.events);
    store.rebuild();

    assert.ok(removed >= 2, "the prior conversation events were removed");
    const topics = store.query({ type: "signal.topic", source: "import:claude", limit: 100 });
    assert.equal(topics.length, 2, "still one per conversation — replaced, not doubled");
    assert.ok(topics.every((t) => /v2/.test((t.payload as { topic: string }).topic)),
      "every surviving topic came from the new extractor");
    store.close();
  });

  test("a conversation outside the re-extracted set is untouched", async () => {
    const store = freshStore();
    const { events } = await importOnce(store, "v1");
    store.append(events);
    store.rebuild();

    store.forgetConversations("import:claude", new Set(["c1"]));

    const remaining = store.query({ type: "signal.topic", source: "import:claude", limit: 100 })
      .map((e) => (e.provenance as { conversation_uuid?: string }).conversation_uuid);
    assert.deepEqual(remaining, ["c2"], "only the named conversation was cleared");
    store.close();
  });

  test("events derived from a re-extracted conversation go too", async () => {
    const store = freshStore();
    const { events } = await importOnce(store, "v1");
    store.append(events);
    const topic = store.query({ type: "signal.topic", source: "import:claude", limit: 10 })
      .find((e) => (e.provenance as { conversation_uuid?: string }).conversation_uuid === "c1")!;
    // The nightly reflection builds assertions on top of imported signals.
    const derived = newEvent("signal.assertion", "system",
      { claim: "thinks in event logs", kind: "behavior", confidence: 0.8, evidence: "topics" },
      { kind: "derived", from: [topic.id] });
    store.append([derived]);

    store.forgetConversations("import:claude", new Set(["c1"]));

    assert.equal(store.getEvents([derived.id]).length, 0,
      "a claim built on a re-extracted conversation must not outlive its source");
    store.close();
  });

  test("an empty set is a no-op — never a full wipe", async () => {
    const store = freshStore();
    const { events } = await importOnce(store, "v1");
    store.append(events);
    const before = store.stats().total;

    assert.equal(store.forgetConversations("import:claude", new Set()), 0);

    assert.equal(store.stats().total, before);
    store.close();
  });
});
