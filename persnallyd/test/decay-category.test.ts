/**
 * Decay used one 7-day half-life for everything, so a career and a debugging
 * session faded at the same rate: after 30 days any signal sat at ~5%, and a
 * two-year import collapsed into "whatever happened last week". That is the
 * opposite of what import-driven onboarding promises — the deepest part of the
 * corpus was the part it threw away.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { DEFAULT_HALF_LIFE_DAYS, halfLifeFor, topicWeight, type WeightSignal } from "../src/decay.js";
import { newEvent } from "../src/events.js";
import { EventStore } from "../src/store.js";

const NOW = Date.parse("2026-08-08T00:00:00Z");
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();

const sig = (days: number): WeightSignal =>
  ({ ts: ago(days), weight: 1, depth: "deep", sentiment: "neutral", intent: "building" });

describe("half-life is chosen per category", () => {
  test("slow-moving parts of a person outlast transient ones", () => {
    assert.ok(halfLifeFor("career") > halfLifeFor("technology"),
      "what someone does for a living changes far more slowly than which library they debugged");
    assert.ok(halfLifeFor("technology") > halfLifeFor("news"));
  });

  test("an unknown category falls back rather than decaying instantly", () => {
    assert.equal(halfLifeFor("not-a-real-category"), 30);
  });

  test("a nonsensical override is ignored, not applied", () => {
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.equal(halfLifeFor("technology", { technology: bad }), DEFAULT_HALF_LIFE_DAYS.technology,
        `${bad} would divide by zero or invert the curve`);
    }
  });

  test("a sane override is applied", () => {
    assert.equal(halfLifeFor("technology", { technology: 45 }), 45);
  });
});

describe("a long-lived interest survives an import of old history", () => {
  test("a 90-day-old career signal keeps meaningful weight; the old rate erased it", () => {
    const career = topicWeight([sig(90)], NOW, "career").weight;
    const news = topicWeight([sig(90)], NOW, "news").weight;

    assert.ok(career > 0.5, `career at 90 days should still register, got ${career.toFixed(3)}`);
    assert.ok(news < 0.01, `news at 90 days should be gone, got ${news.toFixed(4)}`);

    // The old uniform 7-day rate, for comparison: e^(-ln2/7 * 90) ≈ 0.00014.
    assert.ok(career > news * 100, "the whole point: these must not fade at the same rate");
  });

  test("recency still wins within a category — this is not a flat weighting", () => {
    const recent = topicWeight([sig(1)], NOW, "technology").weight;
    const old = topicWeight([sig(120)], NOW, "technology").weight;
    assert.ok(recent > old * 5, "current focus must still outrank a four-month-old signal");
  });

  test("a year-old signal is diminished but not annihilated for slow categories", () => {
    const w = topicWeight([sig(365)], NOW, "health").weight;
    assert.ok(w > 0, "a long-running health concern shouldn't vanish from a multi-year archive");
    assert.ok(w < topicWeight([sig(30)], NOW, "health").weight, "and it still ranks below a recent one");
  });
});

describe("the store applies it end to end", () => {
  const dir = mkdtempSync(join(tmpdir(), "decay-category-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  const topic = (name: string, category: string, days: number) =>
    newEvent("signal.topic", "import:claude", {
      topic: name, weight: 1, intent: "building", sentiment: "neutral",
      depth: "deep", category, entities: [],
    }, { kind: "import", batch: "b1", file: "f" }, ago(days));

  test("two equally old signals rank by how fast their category fades", () => {
    const store = new EventStore(join(dir, "a.db"));
    store.append([topic("my career path", "career", 60), topic("a flaky test", "technology", 60)]);
    store.rebuild(NOW);

    const rows = Object.fromEntries(store.topics().map((t) => [t.topic, t.weight]));
    assert.ok(rows["my career path"]! > rows["a flaky test"]!,
      `career should outweigh a 60-day-old tech signal: ${JSON.stringify(rows)}`);
    store.close();
  });

  test("a config override changes the curve the store uses", () => {
    const cfgDir = mkdtempSync(join(tmpdir(), "decay-cfg-"));
    const prev = process.env.PERSNALLY_DIR;
    process.env.PERSNALLY_DIR = cfgDir;
    after(() => {
      if (prev === undefined) delete process.env.PERSNALLY_DIR; else process.env.PERSNALLY_DIR = prev;
      rmSync(cfgDir, { recursive: true, force: true });
    });

    const store = new EventStore(join(cfgDir, "b.db"));
    store.append([topic("a flaky test", "technology", 60)]);

    writeFileSync(join(cfgDir, "config.json"), JSON.stringify({ decay_half_life_days: { technology: 1 } }));
    store.rebuild(NOW);
    const fast = store.topics()[0]?.weight ?? 0;

    writeFileSync(join(cfgDir, "config.json"), JSON.stringify({ decay_half_life_days: { technology: 365 } }));
    store.rebuild(NOW);
    const slow = store.topics()[0]?.weight ?? 0;

    assert.ok(slow > fast * 10, `the override must actually change weighting: ${fast} vs ${slow}`);
    store.close();
  });
});
