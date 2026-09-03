/**
 * ask_user_model — the Phase 3 decision loop, v1. Agents ask questions about
 * the user; Persnally answers from the evidence with a confidence score and
 * defers to the human below threshold. Every exchange is recorded as an
 * agent.question/agent.answer pair so answer precision is measurable.
 */

import { z } from "zod";
import { newEvent, type PersnallyEvent, type Provenance } from "./events.js";
import type { LlmExtract } from "./llm.js";
import { type Category, readsNothing } from "./permissions.js";
import { overlapScore, queryTokens } from "./search.js";
import type { EventStore, ServedStyleSignal } from "./store.js";
import { projectLabel } from "./importers/claude-code.js";
import { assemblePack, statedConvention, type StyleSignal } from "./stylometry.js";

// Below this, a wrong answer costs more trust than a deferral saves time.
export const CONFIDENCE_THRESHOLD = 0.7;

/**
 * How sure the *evidence* allows an answer to be, independent of how sure the
 * model says it is. The model's number is a self-report — a small local model
 * reported 0.9 on both questions it had no evidence for, and a capable one
 * reported 0.92 citing a prose claim against a repo that contradicted it 185
 * times. So the answer's confidence is the lesser of what the model claims and
 * what the cited events can bear: a stated correction can back anything, an
 * observed convention exactly as much as its count earned it, and a model's
 * reading of prose — or nothing cited at all — stays under the threshold, so
 * the answer defers. This is what makes the loop honest on any engine.
 */
const UNSUPPORTED_CAP = 0.6;
const PROSE_CAP = 0.65;
const OBSERVED_CAP = 0.95;
export function evidenceCap(cited: PersnallyEvent[]): number {
  let cap = 0;
  for (const e of cited) {
    if (e.type === "user.correction") {
      // A deletion states what is false; only a contradiction or edit states what is true.
      if ((e.payload as { action?: string }).action !== "delete") cap = Math.max(cap, 1);
    } else if (e.type === "signal.style") {
      const s = e.payload as StyleSignal;
      cap = Math.max(cap, s.basis === "stylometry" ? s.confidence : OBSERVED_CAP);
    } else cap = Math.max(cap, PROSE_CAP);
  }
  // Nothing cited, or nothing cited that can bear a claim, is the same case.
  return cap > 0 ? cap : UNSUPPORTED_CAP;
}

export const DEFER_MESSAGE = "Persnally can't answer this confidently from the evidence it has — ask the user directly.";

// `confidence` is not bounded at 1 here on purpose: a small local model answers
// "85" as readily as "0.85", and rejecting the whole reply for it turned a
// usable answer into a crash. Normalised below; the recorded value is always 0–1.
const answerSchema = z.object({
  answer: z.string().min(1),
  confidence: z.number().min(0),
  evidence_event_ids: z.array(z.string()).default([]),
});

function normalizeConfidence(raw: number): number {
  if (raw <= 1) return raw;
  return raw <= 100 ? raw / 100 : 1;
}

/**
 * Evidence an answer rests on even when the model cited nothing: a served,
 * project-scoped convention whose leading tool the answer names. Small models
 * often answer correctly and skip the citation list; without this they would
 * defer on every question. Only observed conventions qualify — never prose —
 * and never a contested family, and never when the answer names the runner-up.
 */
/** Where a tool label is first named in the answer, or -1. Tolerant of how
    models write a label: "node --test" matches "node --test", "node:test", "node test". */
function labelAt(answer: string, label: string): number {
  const tokens = label.toLowerCase().split(/\s+/).map((t) => t.replace(/^-+/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const m = new RegExp(`(^|[^a-z0-9])${tokens.join("[\\s:\\-]*")}([^a-z0-9]|$)`).exec(answer.toLowerCase());
  return m ? m.index : -1;
}

/** The tools a served convention names: the leader, the runner-up, or both sides of a contested family. */
function toolsNamed(pattern: string): string[] {
  const both = /^uses both (.+?) \(\d+\) and (.+?) \(\d+\)/.exec(pattern);
  if (both) return [both[1]!, both[2]!];
  const pref = /^prefers (.+?) over (.+)$/.exec(pattern);
  return pref ? [pref[1]!, pref[2]!] : [pattern.replace(/^uses /, "")];
}

export function namesServedTool(answer: string, served: { pattern: string }[]): boolean {
  return served.some((s) => toolsNamed(s.pattern).some((t) => labelAt(answer, t) !== -1));
}

export function impliedEvidence(answer: string, served: { id: string; pattern: string }[]): string[] {
  const ids: string[] = [];
  for (const s of served) {
    if (/^uses both /.test(s.pattern)) continue;
    const pref = /^prefers (.+?) over (.+)$/.exec(s.pattern);
    const leader = labelAt(answer, pref ? pref[1]! : s.pattern.replace(/^uses /, ""));
    if (leader === -1) continue;
    // Models assert first and mention the alternative after ("pnpm, not npm"):
    // the leader has to come first, not stand alone.
    const runnerUp = pref ? labelAt(answer, pref[2]!) : -1;
    if (runnerUp === -1 || leader < runnerUp) ids.push(s.id);
  }
  return ids;
}

const INSTRUCTION = `You are the user's personal model. An AI agent is asking a question about this user so it can proceed without interrupting them. Answer ONLY from the evidence provided.

Rules:
- Answer directly and concisely (1–3 sentences), as actionable guidance to the asking agent.
- confidence = how strongly the evidence supports the answer: 0.9+ directly evidenced, 0.7–0.9 clear pattern, below 0.7 weak or speculative.
- If the evidence doesn't support an answer, say so and set confidence low. A wrong answer is far worse than a deferral.
- List the event ids (given in [brackets]) your answer rests on.`;

export interface AskOptions {
  question: string;
  asker: string;
  source: string;
  provenance: Provenance;
  /** Category allowlist for scoped clients; null = unscoped (full material). */
  allowed?: Category[] | null;
  /**
   * Workspace the question is being asked about. Conventions are project-scoped,
   * and `voice()` withholds another project's — so without this the ask path
   * cannot see which package manager, test runner or merge strategy the user
   * uses anywhere, which is most of what an agent asks about.
   */
  project?: string;
}

export interface AskResult {
  question_id: string;
  answer_id: string;
  answer: string;
  confidence: number;
  deferred: boolean;
  reason?: "low-confidence" | "not-enough-context" | "no-engine";
  evidence_event_ids: string[];
}

export async function askUserModel(
  store: EventStore,
  opts: AskOptions,
  engine: { extract: LlmExtract; model: string } | null,
): Promise<AskResult> {
  const allowed = opts.allowed ?? null;
  const { content, knownIds, served, styleById } = buildMaterial(store, opts.question, allowed, opts.project);

  if (!engine) return record(store, opts, { deferred: true, reason: "no-engine" });
  if (!content) return record(store, opts, { deferred: true, reason: "not-enough-context" });

  let parsed: z.infer<typeof answerSchema>;
  try {
    const raw = await engine.extract({
      model: engine.model,
      instruction: INSTRUCTION,
      schema: answerSchema,
      content: `Question from agent "${opts.asker}":\n${opts.question}\n\n## Evidence about the user\n${content}`,
      maxTokens: 1000,
    });
    parsed = answerSchema.parse(raw);
  } catch (e) {
    // A reply the engine could not shape into an answer is not an answer. It
    // used to propagate and take the caller down; a deferral is the honest result.
    console.error(`ask: engine reply unusable — ${(e instanceof Error ? e.message : String(e)).split("\n")[0]}`);
    return record(store, opts, { deferred: true, reason: "low-confidence", confidence: 0 });
  }
  // A citation is not support. A small model cited a real "uses npm" convention
  // under an answer that said pnpm — so a cited convention only counts when the
  // answer actually names its leading tool, the same test implied evidence
  // passes. Tone, corrections and prose cannot be checked against the text and
  // keep their own caps.
  // Only the miner's patterns name a tool that can be checked ("uses npm",
  // "prefers X over Y"); a live-observed convention ("tests before merge") and
  // a contested family (capped at 0.5, which defers anyway) are kept as cited.
  // An answer that names a served tool is a tool choice, and only tool
  // evidence (or a correction) can carry one: a cited tone signal ("terse, no
  // filler", 0.9) says nothing about which package manager this repo runs.
  const toolAnswer = namesServedTool(parsed.answer, served);
  const supports = (id: string): boolean => {
    const s = styleById.get(id);
    if (!s) return true; // corrections, prose and topics keep their own caps
    if (s.dimension !== "convention" && s.dimension !== "workflow") return !toolAnswer;
    // Only mined tool conventions name something checkable; workflow patterns
    // ("works through GitHub PRs from the CLI") are prose and keep their cap.
    if (s.basis !== "stylometry" || s.dimension !== "convention" || /^uses both /.test(s.pattern)) return true;
    return impliedEvidence(parsed.answer, [s]).length > 0;
  };
  const cited = parsed.evidence_event_ids.filter((id) => knownIds.has(id) && supports(id));
  const evidence = cited.length ? cited : impliedEvidence(parsed.answer, served);
  const confidence = Math.min(normalizeConfidence(parsed.confidence), evidenceCap(store.getEvents(evidence)));

  if (confidence < CONFIDENCE_THRESHOLD) {
    return record(store, opts, {
      deferred: true,
      reason: "low-confidence",
      answer: parsed.answer,
      confidence,
      evidence,
    });
  }
  return record(store, opts, { deferred: false, answer: parsed.answer, confidence, evidence });
}

// Identity-level material (profile, corrections, voice) is relevant to any
// question and always goes in. Topics and assertions are the high-volume half,
// so they're ranked against the question and budgeted — 150 assorted assertions
// crowd out the handful that actually bear on what was asked.
const TOPIC_BUDGET = 24;
const ASSERTION_BUDGET = 24;
// Relevance outranks strength, and strength orders whatever the question doesn't
// match — so a question that matches nothing still gets the strongest material
// rather than an empty corpus.
const RELEVANCE_WEIGHT = 10;
// Candidate pool before ranking, ordered by decayed weight. Matches what
// search_context considers; a relevant topic weaker than the 1000th strongest
// is out of reach, which is an accepted bound rather than an oversight.
const TOPIC_CANDIDATES = 1000;

/** Evidence corpus for the model, ranked against the question. Scoped clients
    get only their allowed categories' topics (never the cross-category profile
    or assertions) — the same boundary the daemon enforces on /profile. */
function buildMaterial(store: EventStore, question: string, allowed: Category[] | null, project?: string): { content: string; knownIds: Set<string>; served: ServedStyleSignal[]; styleById: Map<string, ServedStyleSignal> } {
  const knownIds = new Set<string>();
  if (readsNothing(allowed)) return { content: "", knownIds, served: [], styleById: new Map() };
  const lines: string[] = [];
  const q = queryTokens(question);

  let topics = store.topics(TOPIC_CANDIDATES);
  if (allowed) topics = topics.filter((t) => allowed.includes(t.category as Category));
  const rankedTopics = topics
    .map((t) => ({
      t,
      score: RELEVANCE_WEIGHT * (overlapScore(q, t.topic) * 3 + overlapScore(q, t.entities.join(" ")) * 2) + t.weight,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, TOPIC_BUDGET)
    .map((r) => r.t);
  if (rankedTopics.length) {
    lines.push("## Weighted interests (decayed)");
    for (const t of rankedTopics) {
      const id = t.event_ids[0] ?? "";
      if (id) knownIds.add(id);
      lines.push(
        `- [${id}] ${t.topic} (${t.category}, weight ${t.weight.toFixed(2)}, ${t.dominant_intent}, ${t.signals} signals)`,
      );
    }
  }

  // Project-scoped facts have to say what they are scoped to. Serving "prefers
  // npm over pnpm" unlabelled leaves a model unable to tell whether it applies
  // to the repo being asked about — the evidence was present and unusable.
  // Every served signal carries its id so the model can cite it, and the
  // citation is what lets the answer's confidence be bounded by the evidence.
  const voice = store.voice(project);
  const scoped = voice.items.filter((i) => i.dimension === "convention" || i.dimension === "workflow");
  const tone = voice.items.filter((i) => !scoped.includes(i));
  if (tone.length) {
    for (const s of tone) knownIds.add(s.id);
    lines.push("", "## How the user writes", assemblePack(tone), `(evidence: ${tone.map((s) => `[${s.id}]`).join(" ")})`);
  }
  if (scoped.length) {
    lines.push("", `## How the user works${project ? ` in ${projectLabel(project)}` : ""}` + " (observed behaviour — outranks the general claims above)");
    for (const s of scoped) {
      knownIds.add(s.id);
      lines.push(`- [${s.id}] ${statedConvention(s)}`);
    }
  }


  if (!allowed) {
    const profile = store.getProfile();
    if (profile) {
      lines.push("", "## Synthesized profile");
      lines.push(`# ${profile.headline}`);
      for (const s of profile.sections) lines.push(`### ${s.title}\n${s.body}`);
    }
    const assertions = store.query({ type: "signal.assertion", limit: 1_000 })
      .map((e) => {
        const p = e.payload as { claim: string; kind: string; confidence: number; evidence: string };
        return {
          e, p,
          score: RELEVANCE_WEIGHT * (overlapScore(q, p.claim) * 2 + overlapScore(q, p.evidence)) + p.confidence,
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, ASSERTION_BUDGET);
    if (assertions.length) {
      lines.push("", "## Claims extracted from conversation prose (a model's reading, and may be stale — the observed counts above take precedence on tooling)");
      for (const { e, p } of assertions) {
        knownIds.add(e.id);
        lines.push(`- [${e.id}] (${p.kind}, conf ${p.confidence}) ${p.claim}`);
      }
    }
    // The feedback loop closing: what the user explicitly stated, and what
    // they rejected, both condition future answers.
    const corrections = store.corrections(25);
    if (corrections.length) {
      lines.push("", "## Corrections stated by the user (authoritative — these outrank everything above)");
      for (const c of corrections) {
        knownIds.add(c.id);
        lines.push(`- [${c.id}] ${c.subject ? `re ${c.subject}: ` : ""}${c.correction}`);
      }
    }
    const rejected = store.askHistory(200).items
      .filter((i) => i.verdict === "vetoed" || i.verdict === "edited")
      .slice(0, 10);
    if (rejected.length) {
      lines.push("", "## Past answers the user marked wrong (do not repeat these mistakes)");
      for (const r of rejected) lines.push(`- Q: ${r.question} → rejected answer: ${r.answer}`);
    }
  }

  return { content: lines.join("\n").trim(), knownIds, served: scoped, styleById: new Map(voice.items.map((s) => [s.id, s])) };
}

function record(
  store: EventStore,
  opts: AskOptions,
  outcome: {
    deferred: boolean;
    reason?: AskResult["reason"];
    answer?: string;
    confidence?: number;
    evidence?: string[];
  },
): AskResult {
  const confidence = outcome.confidence ?? 0;
  const q = newEvent("agent.question", opts.source, { question: opts.question, asker: opts.asker }, opts.provenance);
  const a = newEvent(
    "agent.answer",
    opts.source,
    {
      question_id: q.id,
      answer: outcome.answer ?? "",
      confidence,
      deferred: outcome.deferred,
      evidence_event_ids: outcome.evidence ?? [],
    },
    { kind: "derived", from: [q.id] },
  );
  store.append([q, a]);
  return {
    question_id: q.id,
    answer_id: a.id,
    answer: outcome.deferred ? DEFER_MESSAGE : (outcome.answer ?? ""),
    confidence,
    deferred: outcome.deferred,
    ...(outcome.reason ? { reason: outcome.reason } : {}),
    evidence_event_ids: outcome.evidence ?? [],
  };
}
