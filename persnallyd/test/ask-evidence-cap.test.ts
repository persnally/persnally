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
import { askUserModel, CONFIDENCE_THRESHOLD, evidenceCap, impliedEvidence } from "../src/ask.js";
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
const contested = style("uses both npm (60) and pnpm (55) — no clear preference", "stylometry", 0.5, "no clear leader across sessions: npm 60, pnpm 55 invocations");
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
  assert.equal(r.confidence, 0.65, "recorded at what the evidence bears, not what the model said");
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
  const r = await askUserModel(store, OPTS, engine(0.88, [contested.id], seen));
  assert.match(seen.content, new RegExp(`\\[${contested.id}\\] uses both npm \\(60\\) and pnpm \\(55\\)`), "served with its id");
  assert.equal(r.deferred, true);
  assert.equal(r.confidence, 0.5);
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
  assert.deepEqual(impliedEvidence("npm, though they also run pnpm sometimes", served), [], "naming both implies nothing");
  assert.deepEqual(impliedEvidence("run go test", served), [], "a contested family never backs an answer");
  assert.deepEqual(impliedEvidence("cargo test, then grep the output", served), ["c", "d"]);
  assert.deepEqual(impliedEvidence("npmjs.com is the registry", served), [], "whole words only");
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
