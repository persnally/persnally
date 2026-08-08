import assert from "node:assert/strict";
import { test } from "node:test";
import { halfLifeFor, topicWeight } from "../src/decay.js";

const NOW = Date.parse("2026-06-11T00:00:00Z");
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();
const sig = (ts: string, weight = 1, depth = "deep", sentiment = "neutral", intent = "building") =>
  ({ ts, weight, depth, sentiment, intent });

// The half-life is per-category now, so this asserts the curve rather than one
// hardcoded number: whatever a category's half-life is, one of them halves it.
test("a signal halves in weight after exactly one half-life, in every category", () => {
  for (const category of ["technology", "career", "news", "other"]) {
    const h = halfLifeFor(category);
    const fresh = topicWeight([sig(daysAgo(0))], NOW, category).weight;
    const aged = topicWeight([sig(daysAgo(h))], NOW, category).weight;
    assert.ok(Math.abs(aged - fresh / 2) < 1e-9, `${category} (half-life ${h}d) should halve`);
  }
});

// This used to assert "10 signals from 30 days ago weigh less than 2 fresh
// ones", which was a *calibration* claim that only held under the old uniform
// 7-day decay. Under a 30-day half-life those ten genuinely should win —
// someone who discussed a topic ten times last month is more invested than
// someone who mentioned it twice today. The structural property the v1 bug
// broke is that frequency gets no multiplicative bonus on top of decay, so
// that is what's asserted now.
test("frequency is additive, never multiplied on top of decay", () => {
  const one = topicWeight([sig(daysAgo(5))], NOW, "technology").weight;
  const five = topicWeight(Array.from({ length: 5 }, () => sig(daysAgo(5))), NOW, "technology").weight;
  assert.ok(Math.abs(five - one * 5) < 1e-9, `5 identical signals must be exactly 5x one, got ${five} vs ${one * 5}`);
});

test("recency still beats volume at the same decay rate", () => {
  const old = topicWeight(Array.from({ length: 3 }, () => sig(daysAgo(180))), NOW, "technology").weight;
  const fresh = topicWeight([sig(daysAgo(0))], NOW, "technology").weight;
  assert.ok(fresh > old, `one fresh signal (${fresh}) should beat three six-month-old ones (${old})`);
});

test("an unparseable timestamp is skipped, never turning the weight into NaN", () => {
  const w = topicWeight([sig("not-a-date"), sig(daysAgo(0))], NOW).weight;
  assert.ok(Number.isFinite(w), "weight must stay finite");
  assert.equal(w, topicWeight([sig(daysAgo(0))], NOW).weight, "bad signal contributes nothing");
});

test("negative sentiment deprioritizes but never zeroes", () => {
  const neutral = topicWeight([sig(daysAgo(0))], NOW).weight;
  const negative = topicWeight([sig(daysAgo(0), 1, "deep", "negative")], NOW).weight;
  assert.ok(negative < neutral);
  assert.ok(negative >= neutral * 0.2);
});

test("dominant intent is most frequent, not latest", () => {
  const result = topicWeight([
    sig(daysAgo(2), 1, "deep", "neutral", "learning"),
    sig(daysAgo(1), 1, "deep", "neutral", "learning"),
    sig(daysAgo(0), 1, "deep", "neutral", "debugging"),
  ], NOW);
  assert.equal(result.dominant_intent, "learning");
});

test("depth scales the contribution", () => {
  const deep = topicWeight([sig(daysAgo(0), 1, "deep")], NOW).weight;
  const mention = topicWeight([sig(daysAgo(0), 1, "mention")], NOW).weight;
  assert.ok(Math.abs(mention - deep * 0.3) < 1e-9);
});

test("weight is capped at 10", () => {
  const many = Array.from({ length: 100 }, () => sig(daysAgo(0)));
  assert.equal(topicWeight(many, NOW).weight, 10);
});
