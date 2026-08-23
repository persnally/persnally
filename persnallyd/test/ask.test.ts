import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { askUserModel, CONFIDENCE_THRESHOLD, DEFER_MESSAGE } from "../src/ask.js";
import { newEvent } from "../src/events.js";
import type { LlmExtract } from "../src/llm.js";
import { EventStore } from "../src/store.js";

const dir = mkdtempSync(join(tmpdir(), "ask-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const CLI_OPTS = {
  question: "Would they want tests with this change?",
  asker: "cli",
  source: "cli",
  provenance: { kind: "local", surface: "cli" },
} as const;

function seededStore(name: string): EventStore {
  const store = new EventStore(join(dir, `${name}.db`));
  const tech = newEvent("signal.topic", "import:claude", {
    topic: "test-driven development", weight: 0.9, intent: "building", sentiment: "positive",
    depth: "deep", category: "technology", entities: ["node:test"],
  }, { kind: "import", batch: "b1", file: "conversations.json" });
  const biz = newEvent("signal.topic", "import:claude", {
    topic: "fundraising strategy", weight: 0.6, intent: "deciding", sentiment: "neutral",
    depth: "moderate", category: "business", entities: [],
  }, { kind: "import", batch: "b1", file: "conversations.json" });
  const assertion = newEvent("signal.assertion", "import:claude", {
    claim: "Treats unverified code as unfinished", kind: "behavior", confidence: 0.9, evidence: "repeated insistence on test passes",
  }, { kind: "import", batch: "b1", file: "conversations.json" });
  store.append([tech, biz, assertion]);
  store.rebuild();
  store.saveProfile({
    headline: "A verify-everything builder",
    sections: [{ title: "How they work", body: "Ships only verified code.", evidence_event_ids: [assertion.id] }],
    generated_at: new Date().toISOString(),
    model: "test",
  });
  return store;
}

const fakeEngine = (result: { answer: string; confidence: number; evidence_event_ids?: string[] }, calls?: { content?: string; n: number }) => ({
  extract: (async (opts) => {
    if (calls) { calls.n++; calls.content = opts.content; }
    return result;
  }) as LlmExtract,
  model: "fake-model",
});

test("answers above the threshold and records the question/answer pair", async () => {
  const store = seededStore("answers");
  const assertionId = store.query({ type: "signal.assertion" })[0]!.id;
  const r = await askUserModel(store, CLI_OPTS, fakeEngine({
    answer: "Yes — write the tests.", confidence: 0.92, evidence_event_ids: [assertionId, "hallucinated-id"],
  }));

  assert.equal(r.deferred, false);
  assert.equal(r.answer, "Yes — write the tests.");
  assert.equal(r.confidence, 0.92);
  assert.deepEqual(r.evidence_event_ids, [assertionId], "hallucinated evidence ids must be dropped");

  const q = store.query({ type: "agent.question" });
  const a = store.query({ type: "agent.answer" });
  assert.equal(q.length, 1);
  assert.equal(a.length, 1);
  assert.equal(q[0]!.id, r.question_id);
  assert.equal((q[0]!.payload as { asker: string }).asker, "cli");
  // The stored evidence is the filtered list too — a fabricated citation must
  // not survive into the audit trail, only into the discarded response.
  assert.deepEqual(a[0]!.payload, {
    question_id: q[0]!.id,
    answer: "Yes — write the tests.",
    confidence: 0.92,
    deferred: false,
    evidence_event_ids: [assertionId],
  });
  assert.deepEqual(a[0]!.provenance, { kind: "derived", from: [q[0]!.id] });
  store.close();
});

test("defers below the threshold but still records the exchange", async () => {
  const store = seededStore("defers");
  const r = await askUserModel(store, CLI_OPTS, fakeEngine({ answer: "Probably?", confidence: 0.4 }));

  assert.equal(r.deferred, true);
  assert.equal(r.reason, "low-confidence");
  assert.equal(r.answer, DEFER_MESSAGE, "a deferred result must tell the agent to ask the human");
  const a = store.query({ type: "agent.answer" })[0]!;
  assert.deepEqual(a.payload, {
    question_id: r.question_id,
    answer: "Probably?",
    confidence: 0.4,
    deferred: true,
    evidence_event_ids: [],
  });
  store.close();
});

test("confidence exactly at the threshold counts as answered", async () => {
  const store = seededStore("boundary");
  const r = await askUserModel(store, CLI_OPTS, fakeEngine({ answer: "Yes.", confidence: CONFIDENCE_THRESHOLD }));
  assert.equal(r.deferred, false);
  store.close();
});

test("empty store defers without spending inference", async () => {
  const store = new EventStore(join(dir, "empty.db"));
  const calls = { n: 0 };
  const r = await askUserModel(store, CLI_OPTS, fakeEngine({ answer: "x", confidence: 1 }, calls));
  assert.equal(r.deferred, true);
  assert.equal(r.reason, "not-enough-context");
  assert.equal(calls.n, 0, "no material → the LLM must not be called");
  assert.equal(store.query({ type: "agent.answer" }).length, 1, "deferral is still recorded");
  store.close();
});

test("no engine defers with reason no-engine", async () => {
  const store = seededStore("noengine");
  const r = await askUserModel(store, CLI_OPTS, null);
  assert.equal(r.deferred, true);
  assert.equal(r.reason, "no-engine");
  assert.equal(r.confidence, 0);
  store.close();
});

test("scoped clients get only allowed-category topics — no profile, no assertions", async () => {
  const store = seededStore("scoped");
  const calls = { n: 0, content: "" };
  await askUserModel(store, {
    ...CLI_OPTS,
    source: "mcp:cursor",
    provenance: { kind: "mcp", client: "cursor" },
    allowed: ["technology"],
  }, fakeEngine({ answer: "Yes.", confidence: 0.9 }, calls));

  assert.match(calls.content, /test-driven development/);
  assert.doesNotMatch(calls.content, /fundraising strategy/, "topics outside the scope must not leak");
  assert.doesNotMatch(calls.content, /verify-everything builder/, "the cross-category profile must not leak");
  assert.doesNotMatch(calls.content, /Treats unverified code/, "assertions must not leak to scoped clients");
  store.close();
});

test("unscoped material includes profile, assertions, and topics", async () => {
  const store = seededStore("unscoped");
  const calls = { n: 0, content: "" };
  await askUserModel(store, CLI_OPTS, fakeEngine({ answer: "Yes.", confidence: 0.9 }, calls));
  assert.match(calls.content, /test-driven development/);
  assert.match(calls.content, /fundraising strategy/);
  assert.match(calls.content, /verify-everything builder/);
  assert.match(calls.content, /Treats unverified code/);
  store.close();
});

test("user corrections enter the material as authoritative; deletes and empty reasons don't", async () => {
  const store = seededStore("corrections");
  store.append([
    newEvent("user.correction", "cli", { target_id: "npm", action: "contradict", reason: "uses pnpm, not npm" }, { kind: "local", surface: "cli" }),
    newEvent("user.correction", "cli", { target_id: "style:voice|x", action: "delete", reason: "tombstone" }, { kind: "local", surface: "cli" }),
    newEvent("user.correction", "cli", { target_id: "empty", action: "edit", reason: "  " }, { kind: "local", surface: "cli" }),
  ]);
  const calls = { n: 0, content: "" };
  await askUserModel(store, CLI_OPTS, fakeEngine({ answer: "Yes.", confidence: 0.9 }, calls));
  assert.match(calls.content, /Corrections stated by the user/);
  assert.match(calls.content, /re npm: uses pnpm, not npm/);
  assert.doesNotMatch(calls.content, /tombstone/, "delete tombstones are not statements");
  assert.equal(store.corrections().length, 1, "only substantive corrections count");
  store.close();
});

test("vetoed and edited answers feed back into the material; approved ones don't", async () => {
  const store = seededStore("feedback-aware");
  const engine = fakeEngine({ answer: "Use npm for everything.", confidence: 0.9 });
  const bad = await askUserModel(store, { ...CLI_OPTS, question: "Which package manager?" }, engine);
  const good = await askUserModel(store, { ...CLI_OPTS, question: "Tests before merge?" }, fakeEngine({ answer: "Always.", confidence: 0.9 }));
  store.append([
    newEvent("feedback.signal", "dashboard", { subject_id: bad.answer_id, verdict: "vetoed" }, { kind: "local", surface: "dashboard" }),
    newEvent("feedback.signal", "dashboard", { subject_id: good.answer_id, verdict: "approved" }, { kind: "local", surface: "dashboard" }),
  ]);

  const calls = { n: 0, content: "" };
  await askUserModel(store, CLI_OPTS, fakeEngine({ answer: "x", confidence: 0.9 }, calls));
  assert.match(calls.content, /answers the user marked wrong/);
  assert.match(calls.content, /Which package manager\? → rejected answer: Use npm for everything\./);
  assert.doesNotMatch(calls.content, /Tests before merge\? → rejected/, "approved answers are not mistakes");
  store.close();
});

test("scoped clients see neither corrections nor rejected-answer history", async () => {
  const store = seededStore("scoped-fb");
  store.append([
    newEvent("user.correction", "cli", { target_id: "npm", action: "contradict", reason: "uses pnpm, not npm" }, { kind: "local", surface: "cli" }),
  ]);
  const calls = { n: 0, content: "" };
  await askUserModel(store, {
    ...CLI_OPTS, source: "mcp:cursor", provenance: { kind: "mcp", client: "cursor" }, allowed: ["technology"],
  }, fakeEngine({ answer: "Yes.", confidence: 0.9 }, calls));
  assert.doesNotMatch(calls.content, /Corrections stated/, "corrections are cross-category — scoped out");
  store.close();
});

test("askHistory joins questions, answers, and feedback with conservative precision", async () => {
  const store = seededStore("history");
  const engine = fakeEngine({ answer: "Yes.", confidence: 0.9 });
  const r1 = await askUserModel(store, CLI_OPTS, engine);
  const r2 = await askUserModel(store, { ...CLI_OPTS, question: "What tone for this email?" }, engine);
  const r3 = await askUserModel(store, { ...CLI_OPTS, question: "Unanswerable?" }, fakeEngine({ answer: "?", confidence: 0.1 }));

  store.append([
    newEvent("feedback.signal", "dashboard", { subject_id: r1.answer_id, verdict: "approved" }, { kind: "local", surface: "dashboard" }),
    newEvent("feedback.signal", "dashboard", { subject_id: r2.answer_id, verdict: "vetoed" }, { kind: "local", surface: "dashboard" }),
  ]);

  const { items, stats } = store.askHistory();
  assert.equal(items.length, 3);
  const byId = new Map(items.map((i) => [i.answer_id, i]));
  assert.equal(byId.get(r1.answer_id)?.verdict, "approved");
  assert.equal(byId.get(r1.answer_id)?.question, CLI_OPTS.question, "history must join the question text");
  assert.equal(byId.get(r2.answer_id)?.verdict, "vetoed");
  assert.equal(byId.get(r3.answer_id)?.deferred, true);
  assert.equal(stats.asked, 3);
  assert.equal(stats.answered, 2);
  assert.equal(stats.deferred, 1);
  assert.equal(stats.approved, 1);
  assert.equal(stats.vetoed, 1);
  assert.equal(stats.precision, 0.5, "precision = approved / all labeled");
  store.close();
});

test("the ask path sees the conventions of the project it is asked about", async () => {
  // Project-scoping (#219) made voice() withhold another project's conventions.
  // The ask path passed no project, so it withheld *all* of them — the richest
  // disclosure in the product went blind to which package manager, test runner
  // or merge strategy the user uses. A benchmark caught it; this keeps it caught.
  const dir = mkdtempSync(join(tmpdir(), "ask-project-"));
  let store: EventStore | undefined;
  try {
    store = new EventStore(join(dir, "t.db"));
    const conv = (pattern: string, project: string) =>
      newEvent("signal.style", "import:claude-code",
        { dimension: "convention", pattern, polarity: "prefers", confidence: 0.8, evidence: "observed", basis: "stylometry" },
        { kind: "import", batch: "b", file: "f", project });
    store.append([
      conv("prefers npm over pnpm", "/repos/alpha"),
      conv("prefers pnpm over npm", "/repos/beta"),
      newEvent("signal.topic", "import:claude-code", {
        topic: "dependency management", weight: 0.8, intent: "building", sentiment: "positive",
        depth: "deep", category: "technology", entities: [],
      }, { kind: "import", batch: "b", file: "f" }),
    ]);
    store.rebuild();

    // A fake engine that reports the corpus it was given, so this asserts what
    // the model can see rather than what it happens to conclude.
    const seen: string[] = [];
    const engine = {
      model: "test",
      extract: (opts: { content: string }) => {
        seen.push(opts.content);
        return Promise.resolve({ answer: "npm", confidence: 0.9, evidence_event_ids: [] });
      },
    };

    await askUserModel(store, {
      question: "which package manager?", asker: "t", source: "cli",
      provenance: { kind: "local", surface: "cli" }, project: "/repos/alpha",
    }, engine);
    assert.match(seen[0]!, /prefers npm over pnpm/, "the asked project's convention was withheld");
    assert.doesNotMatch(seen[0]!, /prefers pnpm over npm/, "another project's convention leaked in");
    // And it must say what it is scoped to, or a model cannot tell if it applies.
    assert.match(seen[0]!, /How the user works in alpha/);

    await askUserModel(store, {
      question: "which package manager?", asker: "t", source: "cli",
      provenance: { kind: "local", surface: "cli" }, project: "/repos/beta",
    }, engine);
    assert.match(seen[1]!, /prefers pnpm over npm/);
    assert.doesNotMatch(seen[1]!, /prefers npm over pnpm/);
  } finally {
    // Closed before the fixture is removed: an open SQLite handle (plus its WAL
    // and SHM files) makes cleanup fail on platforms that cannot delete open files.
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("observed behaviour is served before, and above, claims extracted from prose", async () => {
  // A prose-derived assertion claiming this user "prefers pnpm and vitest in JS"
  // outranked 625 observed npm invocations in the project being asked about,
  // because the assertion was rendered with its confidence and the convention
  // was rendered as a bare bullet. Both halves of that are fixed here: the
  // convention carries its count, and the claim says where it came from.
  const dir = mkdtempSync(join(tmpdir(), "ask-precedence-"));
  let store: EventStore | undefined;
  try {
    store = new EventStore(join(dir, "t.db"));
    store.append([
      newEvent("signal.style", "import:claude-code", {
        dimension: "convention", pattern: "prefers npm over pnpm", polarity: "prefers",
        confidence: 0.85, evidence: "observed in 625 command(s) across Claude Code sessions",
        basis: "stylometry",
      }, { kind: "import", batch: "b", file: "f", project: "/repos/alpha" }),
      newEvent("signal.assertion", "import:claude", {
        claim: "User prefers pnpm and vitest in JS projects", kind: "behavior",
        confidence: 0.82, evidence: "stated across sessions",
      }, { kind: "import", batch: "b", file: "conversations.json" }),
    ]);
    store.rebuild();

    let corpus = "";
    const engine = {
      model: "test",
      extract: (opts: { content: string }) => {
        corpus = opts.content;
        return Promise.resolve({ answer: "npm", confidence: 0.9, evidence_event_ids: [] });
      },
    };
    await askUserModel(store, {
      question: "which package manager?", asker: "t", source: "cli",
      provenance: { kind: "local", surface: "cli" }, project: "/repos/alpha",
    }, engine);

    assert.match(corpus, /prefers npm over pnpm — observed in 625 commands here/,
      "the count was computed and stored, then dropped at serve time");
    const observed = corpus.indexOf("## How the user works");
    const claimed = corpus.indexOf("## Claims extracted from conversation prose");
    assert.ok(observed >= 0 && claimed >= 0, "both sections should be present");
    assert.ok(observed < claimed, "a model weighs what it reads first; counted evidence goes first");
    assert.match(corpus, /may be stale/, "an extracted claim must not read as ground truth");
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
