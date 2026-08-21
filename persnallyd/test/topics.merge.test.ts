import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { newEvent } from "../src/events.js";
import { searchContext } from "../src/search.js";
import { EventStore } from "../src/store.js";
import { groupNearDuplicates, topicSimilarity, topicTokens, TOPIC_MERGE_THRESHOLD } from "../src/topics.js";

const dir = mkdtempSync(join(tmpdir(), "persnallyd-merge-"));
const store = new EventStore(join(dir, "merge.db"));
after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

const topic = (name: string, category = "technology", weight = 0.8) =>
  newEvent("signal.topic", "import:claude", {
    topic: name, weight, intent: "building", sentiment: "positive", depth: "deep",
    category, entities: [],
  }, { kind: "import", batch: "b1", file: "conversations.json" });

// ── the pure grouping ───────────────────────────────────────────────────────

test("stopwords cannot manufacture similarity", () => {
  // Two unrelated topics that share only filler must not look alike.
  const a = topicTokens("build_a_new_screen_for_the_app");
  const b = topicTokens("review_a_new_contract_for_the_lawyer");
  assert.ok(topicSimilarity(a, b) < TOPIC_MERGE_THRESHOLD, "filler words drove a false match");
});

test("the heaviest phrasing wins, whatever order the variants arrive in", () => {
  const candidates = [
    { key: "v4_api_schema_mapping", category: "technology", weight: 0.5 },
    { key: "v4_api_schema_mapping_and_integration", category: "technology", weight: 3.0 },
    { key: "v4_api_schema_and_mapping", category: "technology", weight: 0.9 },
  ];
  for (const order of [candidates, [...candidates].reverse()]) {
    const map = groupNearDuplicates(order, TOPIC_MERGE_THRESHOLD);
    assert.equal(map.size, 2);
    for (const canonical of map.values()) {
      assert.equal(canonical, "v4_api_schema_mapping_and_integration");
    }
  }
});

test("the same words in a different category stay separate interests", () => {
  const map = groupNearDuplicates([
    { key: "pricing_strategy_validation", category: "business", weight: 2 },
    { key: "pricing_strategy_validation", category: "technology", weight: 1 },
    { key: "pricing_strategy_and_validation", category: "technology", weight: 1 },
  ], TOPIC_MERGE_THRESHOLD);
  // Only the two technology rows may fold together.
  assert.equal(map.size, 1);
});

test("distinct topics that merely share a word are left alone", () => {
  const map = groupNearDuplicates([
    { key: "build_styling_tab_screen_with_query_param_routing", category: "technology", weight: 2.5 },
    { key: "query_parameter_routing_for_ui_state_management", category: "technology", weight: 0.9 },
    { key: "database_schema_design_for_pricing_plan_linking", category: "technology", weight: 1.6 },
    { key: "production_database_reliability_and_safety", category: "technology", weight: 0.8 },
  ], TOPIC_MERGE_THRESHOLD);
  assert.equal(map.size, 0, "a shared word alone drove a merge");
});

test("a distinguishing proper noun keeps two near-identical phrasings apart", () => {
  // Verbatim from a real store: these differ only by "0byte", and that one
  // token is what has to hold them apart — Product Hunt is not 0byte's launch.
  const map = groupNearDuplicates([
    { key: "product_hunt_launch_readiness_validation", category: "business", weight: 0.97 },
    { key: "product_launch_validation_and_release_readiness_for_0byte", category: "business", weight: 0.92 },
  ], TOPIC_MERGE_THRESHOLD);
  assert.equal(map.size, 0, "two different products' launches were fused");
});

test("only the heaviest candidates are considered, so a huge store stays cheap", () => {
  const many = Array.from({ length: 500 }, (_, i) => ({
    key: `unrelated_subject_number_${i}`, category: "technology", weight: 0.001 * i,
  }));
  many.push(
    { key: "shared_topic_alpha_beta_gamma", category: "technology", weight: 9 },
    { key: "shared_topic_alpha_beta_gamma_delta", category: "technology", weight: 8 },
  );
  const map = groupNearDuplicates(many, TOPIC_MERGE_THRESHOLD, 10);
  assert.equal(map.get("shared_topic_alpha_beta_gamma_delta"), "shared_topic_alpha_beta_gamma");
});

// ── the view, end to end ────────────────────────────────────────────────────

test("near-duplicate topics collapse into one row that keeps every signal", () => {
  store.append([
    topic("0byte product strategy and market validation"),
    topic("0byte product strategy and market validation"),
    topic("0byte product strategy validation and market positioning"),
    topic("0byte product strategy validation and market fit"),
  ]);
  store.rebuild();
  const rows = store.topics(50).filter((t) => t.topic.includes("0byte"));
  assert.equal(rows.length, 1, "the same interest still renders as several");
  // Weight is a decayed sum, so the merged row must account for all four events.
  assert.equal(rows[0]!.signals, 4);
  assert.equal(rows[0]!.event_ids.length, 4);
});

test("a folded phrasing is still findable by search", () => {
  // The list collapses to one label, but a phrase the user remembers typing
  // must still resolve — the absorbed phrasings ride along as secondary text.
  const hits = searchContext(store, "market positioning", { limit: 10 });
  assert.ok(hits.length > 0, "the absorbed phrasing fell out of the index");
  assert.ok(hits.some((h) => h.text.includes("0byte")));
});

test("forgetting a merged row deletes every phrasing behind it", () => {
  const before = store.topics(50).filter((t) => t.topic.includes("0byte"));
  assert.equal(before.length, 1);
  const deleted = store.forgetTopic(before[0]!.topic);
  assert.equal(deleted, 4, "a partial delete would leave the topic on screen");
  assert.equal(store.topics(50).filter((t) => t.topic.includes("0byte")).length, 0);
});

test("forgetting by an absorbed phrasing also clears the whole row", () => {
  store.append([
    topic("database schema design for pricing plan linking"),
    topic("database schema design for pricing plan linkage"),
  ]);
  store.rebuild();
  assert.equal(store.topics(50).filter((t) => t.topic.includes("pricing plan")).length, 1);
  // The user may pass the variant the row no longer displays.
  const deleted = store.forgetTopic("database schema design for pricing plan linkage");
  assert.equal(deleted, 2);
  assert.equal(store.topics(50).filter((t) => t.topic.includes("pricing plan")).length, 0);
});

test("forgetting a topic also removes signals written since the last rebuild", () => {
  // The view is derived and append() does not rebuild it, so trusting the row's
  // event_ids alone deleted part of a topic and let the survivor re-create it.
  store.append([topic("caching strategy for the edge")]);
  store.rebuild();
  store.append([topic("caching strategy for the edge")]); // after the rebuild — not in event_ids
  const deleted = store.forgetTopic("caching strategy for the edge");
  assert.equal(deleted, 2, "the signal written since the rebuild survived the delete");
  store.rebuild();
  assert.equal(store.topics(50).filter((t) => t.topic.includes("caching strategy")).length, 0,
    "the topic came back after rebuild");
});

test("the same topic in two categories still shares one identity — documented, not fixed here", () => {
  // Pre-existing behaviour: topic_key is normalizeTopic() alone, so one topic
  // string spans categories. Splitting identity by category changes a PRIMARY
  // KEY the dashboard, search refs and forget all resolve against, so it is a
  // migration rather than a patch. Pinned here so the behaviour is a decision.
  const tech = newEvent("signal.topic", "import:claude", {
    topic: "rust", weight: 0.8, intent: "building", sentiment: "positive",
    depth: "deep", category: "technology", entities: [],
  }, { kind: "import", batch: "b1", file: "f" });
  const creative = newEvent("signal.topic", "import:claude", {
    topic: "rust", weight: 0.8, intent: "building", sentiment: "positive",
    depth: "deep", category: "creative", entities: [],
  }, { kind: "import", batch: "b1", file: "f" });
  store.append([tech, creative]);
  store.rebuild();
  assert.equal(store.topics(80).filter((t) => t.topic === "rust").length, 1, "one row, as designed today");
  assert.equal(store.forgetTopic("rust"), 2, "forget spans both categories — the known consequence");
});
