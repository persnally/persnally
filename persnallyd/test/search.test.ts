import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { newEvent } from "../src/events.js";
import { searchContext } from "../src/search.js";
import { EventStore } from "../src/store.js";

const dir = mkdtempSync(join(tmpdir(), "search-test-"));
const store = new EventStore(join(dir, "test.db"));

before(() => {
  store.append([
    newEvent("signal.topic", "import:claude", {
      topic: "Rust async programming", weight: 0.9, intent: "learning", sentiment: "negative",
      depth: "deep", category: "technology", entities: ["Rust", "tokio"],
    }, { kind: "import", batch: "b1", file: "conversations.json" }),
    newEvent("signal.topic", "import:claude", {
      topic: "fundraising strategy", weight: 0.6, intent: "deciding", sentiment: "neutral",
      depth: "moderate", category: "business", entities: ["pre-seed"],
    }, { kind: "import", batch: "b1", file: "conversations.json" }),
    newEvent("signal.topic", "import:git", {
      topic: "SQLite event store", weight: 0.8, intent: "building", sentiment: "positive",
      depth: "deep", category: "technology", entities: ["SQLite", "WAL"],
    }, { kind: "git", repo: "persnally" }),
    newEvent("signal.assertion", "import:claude", {
      claim: "Prefers SQLite over Postgres for local-first tools", kind: "preference",
      confidence: 0.85, evidence: "chose SQLite in three projects",
    }, { kind: "import", batch: "b1", file: "conversations.json" }),
  ]);
  store.rebuild();
});
after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

test("finds topics by name and entities, assertions by claim", () => {
  const hits = searchContext(store, "sqlite");
  assert.ok(hits.length >= 2);
  const kinds = hits.map((h) => h.kind);
  assert.ok(kinds.includes("topic"), "matches the SQLite topic");
  assert.ok(kinds.includes("assertion"), "matches the preference assertion");
  for (const h of hits) assert.ok(h.event_ids.length, "every hit carries evidence event ids");
});

test("entity-only matches surface the parent topic", () => {
  const hits = searchContext(store, "tokio");
  assert.equal(hits[0]?.kind, "topic");
  assert.match(hits[0]!.text, /Rust async/);
});

test("no token overlap → no hits; stopword-only queries → no hits", () => {
  assert.equal(searchContext(store, "kubernetes").length, 0);
  assert.equal(searchContext(store, "what does the user think about").length, 0);
});

test("scoped clients get only allowed-category topics and no assertions", () => {
  const hits = searchContext(store, "sqlite fundraising", { allowed: ["business"] });
  assert.ok(hits.length >= 1);
  for (const h of hits) {
    assert.equal(h.kind, "topic", "assertions never leak past a scope");
    assert.doesNotMatch(h.text, /SQLite/, "technology topics filtered out");
  }
});

test("higher-weight topics outrank lower on equal match", () => {
  const store2 = new EventStore(join(dir, "rank.db"));
  store2.append([
    newEvent("signal.topic", "cli", {
      topic: "python testing", weight: 0.9, intent: "building", sentiment: "positive",
      depth: "deep", category: "technology", entities: [],
    }, { kind: "local", surface: "cli" }),
    newEvent("signal.topic", "cli", {
      topic: "python scraping", weight: 0.2, intent: "learning", sentiment: "neutral",
      depth: "mention", category: "technology", entities: [],
    }, { kind: "local", surface: "cli" }),
  ]);
  store2.rebuild();
  const hits = searchContext(store2, "python");
  assert.equal(hits.length, 2);
  assert.match(hits[0]!.text, /testing/, "decayed weight breaks the tie");
  store2.close();
});

test("limit caps results", () => {
  assert.ok(searchContext(store, "sqlite", { limit: 1 }).length === 1);
});
