/**
 * An answer's confidence is bounded by what its cited evidence can bear, not
 * by what the model reports. Measured before this existed: a capable model
 * answered "pnpm" at 0.92 for a repo that ran npm 185 times, citing a prose
 * claim; a 3B local model answered both withheld questions at 0.9 with no
 * evidence at all. Neither can happen once the cap is in the loop.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { askUserModel, citationSupports, CONFIDENCE_THRESHOLD, contradictedFamilies, evidenceCap, familiesAsserted, impliedEvidence, namesAnyTool, namesServedTool } from "../src/ask.js";
import { newEvent } from "../src/events.js";
import type { LlmExtract } from "../src/llm.js";
import { EventStore } from "../src/store.js";

const dir = mkdtempSync(join(tmpdir(), "ask-cap-"));
const store = new EventStore(join(dir, "t.db"));
after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

const PROJECT = "/Users/dev/Projects/thing";
const style = (pattern: string, basis: "stylometry" | "observed", confidence: number, evidence: string) =>
  newEvent("signal.style", "import:claude-code",
    { dimension: "convention", pattern, polarity: "prefers", confidence, evidence, basis },
    { kind: "import", batch: "b", file: "t", project: PROJECT });

const prose = newEvent("signal.assertion", "import:claude",
  { claim: "User favors pnpm and vitest in Node stacks", kind: "behavior", confidence: 0.9, evidence: "said so in a chat once" },
  { kind: "import", batch: "b", file: "conversations.json" });
const observedNpm = style("uses npm", "stylometry", 0.85, "observed in 185 command(s) across Claude Code sessions");
const thin = style("uses bun", "stylometry", 0.575, "observed in 3 command(s) across Claude Code sessions");
const contested = style("uses both vitest (9) and jest (8) — no clear preference", "stylometry", 0.5, "no clear leader across sessions: vitest 9, jest 8 invocations");
const live = newEvent("signal.style", "mcp:claude-code",
  { dimension: "convention", pattern: "prefers merge over rebase", polarity: "prefers", confidence: 0.8, evidence: "seen live", basis: "observed" },
  { kind: "mcp", client: "claude-code", session: "s" });
const correction = newEvent("user.correction", "mcp:claude-code",
  { target_id: "package manager", action: "contradict", reason: "uses npm, never pnpm" },
  { kind: "mcp", client: "claude-code", session: "s" });
const deletion = newEvent("user.correction", "dashboard",
  { target_id: "style:convention|uses yarn", action: "delete", reason: "" },
  { kind: "local", surface: "dashboard" });
store.append([prose, observedNpm, thin, contested, live, correction, deletion]);

const OPTS = { question: "npm or pnpm here?", asker: "test", source: "cli", provenance: { kind: "local" as const, surface: "cli" as const }, project: PROJECT };
const engine = (confidence: number, ids: string[], seen?: { content: string }, answer = "npm") => ({
  extract: (async (o) => { if (seen) seen.content = o.content; return { answer, confidence, evidence_event_ids: ids }; }) as LlmExtract,
  model: "fake",
});

test("evidenceCap: what each class of evidence can bear", () => {
  assert.equal(evidenceCap([]), 0.6, "nothing cited stays under the threshold");
  assert.equal(evidenceCap([prose]), 0.65, "a model's reading of prose stays under the threshold");
  assert.equal(evidenceCap([observedNpm]), 0.85, "an observed convention bears exactly what its count earned");
  assert.equal(evidenceCap([thin]), 0.575, "three uses is a thin habit and defers");
  assert.equal(evidenceCap([contested]), 0.5, "a contested family defers");
  assert.equal(evidenceCap([live]), 0.95, "a live-observed signal is strong evidence");
  assert.equal(evidenceCap([correction]), 1, "a stated correction can back anything");
  assert.equal(evidenceCap([deletion]), 0.6, "a deletion says what is false, not what is true — it backs nothing");
  assert.equal(evidenceCap([prose, observedNpm]), 0.85, "the strongest cited evidence sets the cap");
});

test("a confident answer resting only on prose defers — the pnpm-at-0.92 case", async () => {
  const r = await askUserModel(store, OPTS, engine(0.92, [prose.id]));
  assert.equal(r.deferred, true);
  assert.equal(r.reason, "low-confidence");
  assert.equal(r.confidence, 0.6, "prose cannot back a tool claim, so the answer is unsupported — recorded as such, not as what the model said");
});

test("the same answer citing the observed count is answered, at the count's confidence", async () => {
  const r = await askUserModel(store, OPTS, engine(0.92, [observedNpm.id]));
  assert.equal(r.deferred, false);
  assert.equal(r.confidence, 0.85);
});

test("a stated correction lets the model's own confidence stand", async () => {
  const r = await askUserModel(store, OPTS, engine(0.92, [correction.id]));
  assert.equal(r.deferred, false);
  assert.equal(r.confidence, 0.92);
});

test("citing nothing, with an answer nothing served supports, defers — the small-model case", async () => {
  const none = await askUserModel(store, OPTS, engine(0.9, [], undefined, "yarn"));
  assert.equal(none.deferred, true);
  assert.equal(none.confidence, 0.6);
  const fake = await askUserModel(store, OPTS, engine(0.9, ["not-an-event"], undefined, "yarn"));
  assert.equal(fake.deferred, true);
  assert.equal(fake.evidence_event_ids.length, 0);
});

test("a contested family is served, cite-able, and defers rather than picking a side", async () => {
  const seen = { content: "" };
  // Picking a side: the contested signal cannot agree with "jest", nothing else backs it → unsupported.
  const side = await askUserModel(store, { ...OPTS, question: "vitest or jest?" }, engine(0.88, [contested.id], seen, "jest"));
  assert.match(seen.content, new RegExp(`\\[${contested.id}\\] uses both vitest \\(9\\) and jest \\(8\\)`), "served with its id");
  assert.equal(side.deferred, true);
  // Not picking a side: the contested signal is the evidence, and its 0.5 defers.
  const honest = await askUserModel(store, { ...OPTS, question: "vitest or jest?" }, engine(0.88, [contested.id], undefined, "No clear preference here — ask the user which they want."));
  assert.equal(honest.deferred, true);
  assert.equal(honest.confidence, 0.5);
});

test("conventions and tone are rendered with their ids so they can be cited", async () => {
  const tone = newEvent("signal.style", "cli",
    { dimension: "voice", pattern: "terse, no filler", polarity: "does", confidence: 0.9, evidence: "x", basis: "stylometry" },
    { kind: "local", surface: "cli" });
  store.append([tone]);
  const seen = { content: "" };
  await askUserModel(store, OPTS, engine(0.9, [observedNpm.id], seen));
  assert.match(seen.content, new RegExp(`\\[${observedNpm.id}\\] uses npm — observed in 185 commands here`));
  assert.match(seen.content, new RegExp(`\\(evidence: .*\\[${tone.id}\\]`), "tone signals expose ids beside the pack");
});

test("the model's confidence still governs when it is the lower of the two", async () => {
  const r = await askUserModel(store, OPTS, engine(CONFIDENCE_THRESHOLD - 0.01, [correction.id]));
  assert.equal(r.deferred, true);
  assert.equal(r.confidence, CONFIDENCE_THRESHOLD - 0.01);
});

// ── What the small-model run exposed ──────────────────────────────────────

test("a confidence given as a percentage is read as one, not rejected", async () => {
  const r = await askUserModel(store, OPTS, engine(85, [observedNpm.id]));
  assert.equal(r.deferred, false);
  assert.equal(r.confidence, 0.85);
  const clamped = await askUserModel(store, OPTS, engine(150, [correction.id]));
  assert.equal(clamped.confidence, 1);
});

test("an engine reply that cannot be shaped into an answer defers instead of throwing", async () => {
  const broken = { extract: (async () => ({ answer: "npm", confidence: "high" })) as unknown as LlmExtract, model: "fake" };
  const r = await askUserModel(store, OPTS, broken);
  assert.equal(r.deferred, true);
  assert.equal(r.confidence, 0);
  const thrown = { extract: (async () => { throw new Error("engine down"); }) as LlmExtract, model: "fake" };
  const r2 = await askUserModel(store, OPTS, thrown);
  assert.equal(r2.deferred, true);
  assert.equal(store.query({ type: "agent.answer" }).length >= 2, true, "both exchanges are still recorded");
});

test("an uncited answer that names a served convention's leading tool is attributed to it", async () => {
  // Small models answer correctly and skip the citation list. "npm" against a
  // served "uses npm" convention rests on that convention whether cited or not.
  const r = await askUserModel(store, OPTS, engine(0.9, []));
  assert.equal(r.deferred, false, "the served 'uses npm' convention backs an answer of 'npm'");
  assert.equal(r.confidence, 0.85);
  assert.deepEqual(r.evidence_event_ids, [observedNpm.id]);
});

test("impliedEvidence: leader yes, runner-up no, contested never, prose never", () => {
  const served = [
    { id: "a", pattern: "prefers npm over pnpm" },
    { id: "b", pattern: "uses both go test (9) and vitest (8) — no clear preference" },
    { id: "c", pattern: "cargo test" },
    { id: "d", pattern: "uses grep" },
  ];
  assert.deepEqual(impliedEvidence("Use npm here.", served), ["a"]);
  assert.deepEqual(impliedEvidence("pnpm install", served), [], "naming the runner-up implies nothing");
  assert.deepEqual(impliedEvidence("npm — not pnpm — in this repo", served), ["a"], "the leader first, the alternative mentioned after, is an assertion of the leader");
  assert.deepEqual(impliedEvidence("pnpm mostly, though npm in CI", served), [], "the runner-up first is an assertion of the runner-up");
  assert.deepEqual(impliedEvidence("run go test", served), [], "a contested family never backs an answer");
  assert.deepEqual(impliedEvidence("cargo test, then grep the output", served), ["c", "d"]);
  assert.deepEqual(impliedEvidence("npmjs.com is the registry", served), [], "whole words only");
  const runner = [{ id: "n", pattern: "prefers node --test over vitest" }];
  for (const phrasing of ["node --test", "node:test", "the built-in node test runner", "Node --test (no vitest)"]) {
    assert.deepEqual(impliedEvidence(phrasing, runner), ["n"], `label spelled as ${JSON.stringify(phrasing)}`);
  }
  assert.deepEqual(impliedEvidence("vitest, since node --test lacks mocking", runner), [], "vitest asserted first");
});

test("a cited convention counts only when the answer agrees with it — the paragraph-of-prose case", async () => {
  // llama3.2 cited the real "uses npm" convention under an answer that said
  // "favors pnpm and tsc … vitest …". The citation must not carry that answer.
  const r = await askUserModel(store, OPTS, engine(0.85, [observedNpm.id], undefined,
    "User favors pnpm and tsc in Node.js stacks, vitest for testing, and psql for databases."));
  assert.equal(r.deferred, true, "an answer that contradicts what it cites is unsupported");
  assert.equal(r.evidence_event_ids.length, 0);
  const agree = await askUserModel(store, OPTS, engine(0.85, [observedNpm.id], undefined, "npm — that is what this repo runs."));
  assert.equal(agree.deferred, false);
  assert.deepEqual(agree.evidence_event_ids, [observedNpm.id]);
});

test("a cited tone signal cannot carry a tool answer, but still carries a tone answer", async () => {
  const tone = store.query({ type: "signal.style", limit: 100 }).find((e) => (e.payload as { dimension: string }).dimension === "voice")!;
  // "Use pnpm" citing "terse, no filler" (0.9): the citation says nothing about
  // package managers, and no served tool convention agrees with pnpm.
  const tool = await askUserModel(store, OPTS, engine(0.9, [tone.id], undefined, "Use pnpm."));
  assert.equal(tool.deferred, true);
  assert.equal(tool.evidence_event_ids.length, 0);
  // A tone question answered from tone evidence keeps the tone signal's confidence.
  const toneQ = { ...OPTS, question: "What tone for this Slack message?" };
  const style = await askUserModel(store, toneQ, engine(0.9, [tone.id], undefined, "Terse, no filler, no greeting."));
  assert.equal(style.deferred, false);
  assert.equal(style.confidence, 0.9);
  assert.deepEqual(style.evidence_event_ids, [tone.id]);
});

test("namesServedTool sees leaders, runners-up and both sides of a contested family", () => {
  const served = [{ pattern: "prefers npm over pnpm" }, { pattern: "uses both go test (9) and vitest (8) — no clear preference" }, { pattern: "cargo test" }];
  assert.equal(namesServedTool("pnpm install", served), true);
  assert.equal(namesServedTool("vitest is fine", served), true);
  assert.equal(namesServedTool("cargo test --all", served), true);
  assert.equal(namesServedTool("keep it terse", served), false);
});

// ── What the final small-model run exposed: unrelated citations under a tool answer ──

test("a tool answer naming a tool that is NOT served here is still a tool answer — tone cannot carry it", async () => {
  // llama3.2 answered "pnpm" for a repo whose only served convention is
  // "uses npm", citing a tone signal. "pnpm" names no served tool, but it
  // names a known one, and that is what makes it a tool choice.
  const tone = store.query({ type: "signal.style", limit: 100 }).find((e) => (e.payload as { dimension: string }).dimension === "voice")!;
  const r = await askUserModel(store, OPTS, engine(0.92, [tone.id], undefined, "pnpm"));
  assert.equal(r.deferred, true);
  assert.equal(r.evidence_event_ids.length, 0);
  assert.ok(namesAnyTool("pnpm") && !namesServedTool("pnpm", [{ pattern: "uses npm" }]), "the gap the old test left open");
});

test("a correction carries a tool answer only when it names that tool", async () => {
  // The store's correction says "uses npm, never pnpm".
  const wrongTool = await askUserModel(store, OPTS, engine(0.95, [correction.id], undefined, "vitest"));
  assert.equal(wrongTool.deferred, true, "an unrelated correction is not evidence for vitest");
  const rightTool = await askUserModel(store, OPTS, engine(0.95, [correction.id], undefined, "npm — never pnpm here."));
  assert.equal(rightTool.deferred, false);
  assert.equal(rightTool.confidence, 0.95, "a correction naming the tool lets the model's confidence stand");
  const notATool = await askUserModel(store, { ...OPTS, question: "tests before merge?" }, engine(0.9, [correction.id], undefined, "Yes, always."));
  assert.equal(notATool.deferred, false, "an answer that names no tool keeps every citation");
});

test("an observed free-form convention carries a tool answer only when its text names the tool", async () => {
  // "prefers merge over rebase" (observed, 0.95) under an answer about npm shares no tool.
  const r = await askUserModel(store, OPTS, engine(0.9, [live.id], undefined, "npm"));
  assert.equal(r.deferred, false, "…but 'npm' is then carried by the served 'uses npm' convention through implied evidence");
  assert.deepEqual(r.evidence_event_ids, [observedNpm.id], "the unrelated observed signal was dropped; the agreeing convention was attributed");
  const rebase = await askUserModel(store, { ...OPTS, question: "merge or rebase?" }, engine(0.9, [live.id], undefined, "merge, not rebase"));
  assert.equal(rebase.deferred, false);
  assert.deepEqual(rebase.evidence_event_ids, [live.id]);
});

test("citationSupports, by class", () => {
  const conv = { ...observedNpm, payload: observedNpm.payload };
  assert.equal(citationSupports(conv, "npm", true), true);
  assert.equal(citationSupports(conv, "pnpm", true), false);
  assert.equal(citationSupports(live, "merge, not rebase", true), true);
  assert.equal(citationSupports(live, "vitest", true), false);
  assert.equal(citationSupports(live, "Yes, always.", false), true);
  assert.equal(citationSupports(correction, "npm", true), true);
  assert.equal(citationSupports(correction, "vitest", true), false);
  assert.equal(citationSupports(deletion, "vitest", true), true, "a deletion passes but bears nothing in evidenceCap");
  assert.equal(citationSupports(prose, "pnpm", true), true, "prose passes and is capped at 0.65 by evidenceCap");
});

// ── The final small-model shape: a paragraph asserting in several families ──

test("the headline claim must be backed; a passing mention may be unbacked but never contradicted", async () => {
  // The store serves "uses npm" for this project and no test runner.
  // Leading with an unbacked test runner: unsupported as a whole.
  const lead = await askUserModel(store, OPTS, engine(0.9, [observedNpm.id], undefined,
    "They use vitest for tests, and npm as the package manager."));
  assert.equal(lead.deferred, true);
  assert.equal(lead.evidence_event_ids.length, 0);
  // Leading with the backed npm and mentioning an unbacked test runner in passing: answered on the npm evidence.
  const passing = await askUserModel(store, OPTS, engine(0.9, [observedNpm.id], undefined,
    "npm as the package manager; they also run vitest for tests."));
  assert.equal(passing.deferred, false);
  assert.equal(passing.confidence, 0.85);
  // Once the store serves a test runner, a contradicting mention sinks the answer even in passing.
  const runner = style("prefers node --test over vitest", "stylometry", 0.85, "observed in 143 command(s) across Claude Code sessions");
  store.append([runner]);
  const contradicted = await askUserModel(store, OPTS, engine(0.9, [observedNpm.id], undefined,
    "npm as the package manager; they also run vitest for tests."));
  assert.equal(contradicted.deferred, true, "vitest contradicts the served node --test");
  assert.deepEqual([...familiesAsserted("They use vitest for tests, and npm as the package manager.").entries()].sort(),
    [["package-manager", "npm"], ["test-runner", "vitest"]].sort(), "test runners assert as one family, as the benchmark grades them");
  assert.deepEqual(contradictedFamilies(new Map([["test-runner", "vitest"]]), [{ pattern: "go test" }]), ["test-runner"],
    "a go test project contradicts a vitest claim even though the rule table files them under different languages");
  assert.deepEqual(contradictedFamilies(new Map([["test-runner", "vitest"]]), [{ pattern: "uses both vitest (9) and jest (8) — no clear preference" }]), [],
    "a contested family contradicts nothing");
});

test("the first-named tool in a family is the assertion, so 'pnpm … npm' asserts pnpm", async () => {
  // llama3.2 answered a paragraph mentioning pnpm first and npm later for a
  // repo that serves "uses npm"; the grader — and the cap — read pnpm.
  const r = await askUserModel(store, OPTS, engine(0.85, [observedNpm.id], undefined,
    "The user prefers pnpm for speed, though npm appears in older sessions."));
  assert.equal(r.deferred, true);
  const ok = await askUserModel(store, OPTS, engine(0.85, [observedNpm.id], undefined,
    "npm here; pnpm only shows up in one older session."));
  assert.equal(ok.deferred, false);
  assert.equal(ok.confidence, 0.85);
});

// ── Direction matters: a text that names the alternative is not a vote for it ──

test("an observed 'prefers merge over rebase' backs merge and never rebase", async () => {
  const q = { ...OPTS, question: "merge or rebase?" };
  const wrong = await askUserModel(store, q, engine(0.9, [live.id], undefined, "rebase"));
  assert.equal(wrong.deferred, true, "the citation names rebase only as the thing the user avoids");
  assert.equal(wrong.evidence_event_ids.length, 0);
  const right = await askUserModel(store, q, engine(0.9, [live.id], undefined, "merge"));
  assert.equal(right.deferred, false);
  assert.deepEqual(right.evidence_event_ids, [live.id]);
});

test("a correction 'uses npm, never pnpm' backs npm and never pnpm", async () => {
  const wrong = await askUserModel(store, OPTS, engine(0.95, [correction.id], undefined, "pnpm"));
  assert.equal(wrong.deferred, true);
  assert.equal(wrong.evidence_event_ids.length, 0);
  const right = await askUserModel(store, OPTS, engine(0.95, [correction.id], undefined, "npm"));
  assert.equal(right.deferred, false);
  assert.equal(right.confidence, 0.95);
});

test("negation reads the same way in an answer: 'not pnpm — npm' asserts npm", () => {
  assert.deepEqual([...familiesAsserted("not pnpm — npm, always").entries()], [["package-manager", "npm"]]);
  assert.deepEqual([...familiesAsserted("never rebase; merge").entries()], [["git-integrate", "merge"]]);
  assert.deepEqual([...familiesAsserted("avoid vitest").entries()], [], "a lone negated mention asserts nothing");
  assert.deepEqual([...familiesAsserted("Node --test (no vitest)").entries()], [["test-runner", "node --test"]]);
});
