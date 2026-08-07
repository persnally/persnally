/**
 * The lookups literal substring matching could never do. Search is the tool an
 * AI reaches for mid-conversation, so a miss isn't a degraded result — it's
 * Persnally silently claiming to know nothing about something it knows.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { newEvent } from "../src/events.js";
import { matchExpression, queryTokens, searchContext } from "../src/search.js";
import { EventStore } from "../src/store.js";

const dir = mkdtempSync(join(tmpdir(), "search-semantic-"));
const store = new EventStore(join(dir, "test.db"));
after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

const topic = (name: string, entities: string[], category = "technology", weight = 0.8) =>
  newEvent("signal.topic", "import:claude", {
    topic: name, weight, intent: "building", sentiment: "neutral",
    depth: "deep", category, entities,
  }, { kind: "import", batch: "b1", file: "f" });

before(() => {
  store.append([
    topic("PostgreSQL 16 tuning", ["Postgres", "indexes"]),
    topic("vitest testing setup", ["vitest"]),
    topic("Kubernetes cluster ops", ["k8s", "helm"]),
    topic("trusted execution environments", ["TEE"]),
    topic("Rust ownership model", ["Rust"]),
    topic("writing documentation for the API", ["docs"]),
    newEvent("signal.assertion", "import:claude", {
      claim: "Prefers deterministic tests over mocks", kind: "preference",
      confidence: 0.9, evidence: "said so repeatedly",
    }, { kind: "import", batch: "b1", file: "f" }) as never,
  ].filter(Boolean));
  store.rebuild();
});

const found = (q: string) => searchContext(store, q).map((h) => h.text);

describe("lookups that substring matching got wrong", () => {
  test("prefix: 'postgres' finds 'PostgreSQL 16 tuning'", () => {
    assert.ok(found("postgres").some((t) => /PostgreSQL/.test(t)),
      "the exact case the issue named — a shorter form of the same word");
  });

  test("stemming: 'tests' finds 'testing'", () => {
    assert.ok(found("tests").some((t) => /testing/.test(t)),
      "an AI will ask about 'tests'; the topic is recorded as 'testing'");
  });

  test("alias: 'k8s' finds 'Kubernetes' and vice versa", () => {
    assert.ok(found("k8s").some((t) => /Kubernetes/.test(t)));
    assert.ok(found("kubernetes").some((t) => /Kubernetes/.test(t)));
  });

  test("word boundaries: 'rust' does not match 'trusted'", () => {
    const hits = found("rust");
    assert.ok(hits.some((t) => /Rust ownership/.test(t)), "the real match is returned");
    assert.ok(!hits.some((t) => /trusted execution/.test(t)),
      "substring matching returned this; it is a different word");
  });

  test("relevance ranking: a rare term outranks a common one (bm25 gives IDF)", () => {
    const hits = searchContext(store, "kubernetes documentation");
    assert.ok(hits.length >= 2);
    assert.match(hits[0]!.text, /Kubernetes/,
      "the distinctive term should lead, not the one that appears everywhere");
  });
});

describe("it still refuses to invent matches", () => {
  test("a term genuinely absent from the store returns nothing", () => {
    assert.deepEqual(found("quantumcryptography"), []);
  });

  test("a stopword-only query returns nothing", () => {
    assert.deepEqual(found("what does the user think about"), []);
  });
});

describe("the match expression is safe to build from arbitrary input", () => {
  test("tokens with FTS operators are quoted, not interpreted", () => {
    assert.equal(matchExpression(["c++"]), '"c++"*');
    assert.equal(matchExpression(["next.js"]), '"next.js"*');
  });

  test("an embedded quote cannot break out of the phrase", () => {
    const expr = matchExpression(queryTokens('foo" OR bar'));
    assert.ok(!/[^*]"\s*OR\s*"[^"]*$/.test(expr.replace(/"\w[\w.+#-]*"\*/g, "")),
      `expression must stay well-formed: ${expr}`);
    // The real guarantee: whatever it builds, the store never throws on it.
    assert.doesNotThrow(() => searchContext(store, 'foo" OR bar'));
  });

  test("a query that is pure punctuation is handled, not crashed on", () => {
    for (const q of ["***", '"""', "()", "-", "  "]) {
      assert.doesNotThrow(() => searchContext(store, q), `query ${JSON.stringify(q)} must not throw`);
    }
  });

  test("aliases expand into the expression", () => {
    assert.match(matchExpression(["k8s"]), /kubernetes/);
  });
});

describe("the scope boundary still holds", () => {
  test("a scoped client gets only allowed categories and never assertions", () => {
    store.append([topic("fundraising strategy", ["pre-seed"], "business", 0.7)]);
    store.rebuild();

    const hits = searchContext(store, "fundraising tests", { allowed: ["business"] });

    assert.ok(hits.length >= 1);
    assert.ok(hits.every((h) => h.kind === "topic"), "assertions are cross-category — never for a scoped client");
    assert.ok(!hits.some((h) => /testing/.test(h.text)), "technology topics are out of scope");
  });
});
