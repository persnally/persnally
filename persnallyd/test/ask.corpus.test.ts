/**
 * The ask corpus is ranked against the question. Before this, buildMaterial
 * didn't receive the question at all, so every ask sent the same ~150 assertions
 * regardless of what was asked — the material that actually bore on the question
 * was crowded out by whatever happened to be newest.
 *
 * The decisive fixture: relevant claims are given LOW confidence and OLD
 * timestamps, while the noise is high-confidence and recent. Only relevance
 * ranking can surface them; recency or confidence ordering cannot.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { askUserModel } from "../src/ask.js";
import { newEvent } from "../src/events.js";
import type { LlmExtract } from "../src/llm.js";
import { EventStore } from "../src/store.js";

const dir = mkdtempSync(join(tmpdir(), "ask-corpus-"));
const store = new EventStore(join(dir, "t.db"));
after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

const NOW = Date.now();
const DAY = 86_400_000;
const iso = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString();

const RELEVANT_DEP = "hand-rolls small utilities instead of adding a new dependency";
const RELEVANT_EMAIL = "keeps customer email tone terse and factual";

let anchor: string;

before(() => {
  const topics = Array.from({ length: 60 }, (_, i) =>
    newEvent("signal.topic", "import:claude", {
      topic: `${["kubernetes", "billing", "dependency choices", "email drafting"][i % 4]} ${Math.floor(i / 4)}`,
      weight: i % 4 < 2 ? 0.9 : 0.1, // the relevant topics are the WEAK ones
      intent: "building", sentiment: "neutral", depth: "moderate",
      category: "technology", entities: [],
    }, { kind: "import", batch: "b", file: "f" }, iso(i % 90)));
  store.append(topics);
  anchor = topics[0]!.id;

  // 120 recent, high-confidence, irrelevant claims.
  store.append(Array.from({ length: 120 }, (_, i) =>
    newEvent("signal.assertion", "system", {
      claim: `Noise ${i}: unrelated observation about cluster sizing`,
      kind: "behavior", confidence: 0.95, evidence: "noise",
    }, { kind: "derived", from: [anchor] }, iso(1))));

  // 2 old, low-confidence, highly relevant claims.
  store.append([
    newEvent("signal.assertion", "system", { claim: RELEVANT_DEP, kind: "behavior", confidence: 0.4, evidence: "seen in reviews" }, { kind: "derived", from: [anchor] }, iso(280)),
    newEvent("signal.assertion", "system", { claim: RELEVANT_EMAIL, kind: "behavior", confidence: 0.4, evidence: "seen in drafts" }, { kind: "derived", from: [anchor] }, iso(280)),
  ]);
  store.append([
    newEvent("user.correction", "cli", { target_id: "topic:x", action: "contradict", reason: "Authoritative correction" }, { kind: "local", surface: "cli" }),
  ]);
  store.rebuild();
  store.saveProfile({
    headline: "Builds payment infrastructure.",
    sections: [{ title: "How you work", body: "Verification-first.", evidence_event_ids: [] }],
    generated_at: new Date().toISOString(), model: "test",
  });
});

/** Captures the evidence material the model would see, with the question stripped. */
async function material(question: string, allowed: Parameters<typeof askUserModel>[1]["allowed"] = null): Promise<string> {
  let seen = "";
  const engine = {
    extract: (async (opts: { content: string }) => {
      seen = opts.content;
      return { answer: "x", confidence: 0.9, evidence_event_ids: [] };
    }) as unknown as LlmExtract,
    model: "fake",
  };
  await askUserModel(store, { question, asker: "cursor", source: "mcp:cursor", provenance: { kind: "mcp", client: "cursor" }, allowed }, engine);
  const marker = "## Evidence about the user\n";
  return seen.slice(seen.indexOf(marker) + marker.length);
}

const assertionsIn = (corpus: string) => (corpus.match(/^- \[.*\] \(behavior/gm) ?? []).length;

describe("the corpus is ranked against the question", () => {
  test("a low-confidence relevant claim outranks 120 high-confidence irrelevant ones", async () => {
    const corpus = await material("Should I add a new dependency or hand-roll this?");
    assert.ok(corpus.includes(RELEVANT_DEP),
      "the relevant claim must surface despite conf 0.4 against 120 claims at conf 0.95");
  });

  test("a different question surfaces different material", async () => {
    const dep = await material("Should I add a new dependency or hand-roll this?");
    const email = await material("What tone should I use for this customer email?");
    assert.notEqual(dep, email, "the corpus must depend on the question");
    assert.ok(email.includes(RELEVANT_EMAIL), "the email question surfaces the email claim");
    assert.ok(!email.includes(RELEVANT_DEP), "and does not drag in the dependency claim");
    assert.ok(!dep.includes(RELEVANT_EMAIL), "and vice versa");
  });

  test("relevance beats decayed weight for topics too", async () => {
    // "dependency choices" topics carry weight 0.1; "kubernetes" carries 0.9.
    const corpus = await material("Should I add a new dependency or hand-roll this?");
    assert.match(corpus, /dependency choices/, "the weak but relevant topic surfaces");
  });
});

describe("budgets and graceful degradation", () => {
  test("a question matching nothing still gets a full, strongest-first corpus", async () => {
    const corpus = await material("zzqqx unrelated gibberish tokens");
    assert.equal(assertionsIn(corpus), 24, "the budget is filled by confidence when relevance is zero");
    assert.match(corpus, /Synthesized profile/);
    assert.match(corpus, /Authoritative correction/);
    assert.ok(corpus.length > 500, "never an empty corpus");
  });

  test("assertions are capped at the budget, not dumped wholesale", async () => {
    const corpus = await material("dependency");
    assert.equal(assertionsIn(corpus), 24, "122 assertions exist; only the budget is sent");
  });

  test("identity material is present regardless of the question", async () => {
    for (const q of ["dependency", "email tone", "zzqqx gibberish"]) {
      const corpus = await material(q);
      assert.match(corpus, /Synthesized profile/, `profile missing for "${q}"`);
      assert.match(corpus, /Authoritative correction/, `corrections missing for "${q}"`);
    }
  });

  test("the corpus is materially smaller than dumping everything", async () => {
    const corpus = await material("Should I add a new dependency or hand-roll this?");
    // 122 assertions at ~90 chars each would exceed 10k on their own.
    assert.ok(corpus.length < 10_000, `expected a bounded corpus, got ${corpus.length} chars`);
  });
});

describe("the scoped boundary still holds", () => {
  test("a scoped client gets ranked topics only — no profile, assertions or corrections", async () => {
    const corpus = await material("Should I add a new dependency or hand-roll this?", ["technology"]);
    assert.match(corpus, /Weighted interests/);
    assert.ok(!corpus.includes("Synthesized profile"), "the cross-category profile must not leak");
    assert.ok(!corpus.includes(RELEVANT_DEP), "assertions must not leak to a scoped client");
    assert.ok(!corpus.includes("Authoritative correction"), "corrections must not leak to a scoped client");
  });

  test("a scoped client's topics are still ranked by the question", async () => {
    const dep = await material("dependency choices", ["technology"]);
    const kube = await material("kubernetes", ["technology"]);
    assert.notEqual(dep, kube, "ranking applies inside the scope too");
    assert.match(dep, /dependency choices/);
  });
});
