/**
 * ask_user_model — the Phase 3 decision loop, v1. Agents ask questions about
 * the user; Persnally answers from the evidence with a confidence score and
 * defers to the human below threshold. Every exchange is recorded as an
 * agent.question/agent.answer pair so answer precision is measurable.
 */

import { z } from "zod";
import { newEvent, type Provenance } from "./events.js";
import type { LlmExtract } from "./llm.js";
import type { Category } from "./permissions.js";
import { overlapScore, queryTokens } from "./search.js";
import type { EventStore } from "./store.js";

// Below this, a wrong answer costs more trust than a deferral saves time.
export const CONFIDENCE_THRESHOLD = 0.7;

export const DEFER_MESSAGE = "Persnally can't answer this confidently from the evidence it has — ask the user directly.";

const answerSchema = z.object({
  answer: z.string().min(1),
  confidence: z.number().min(0).max(1),
  evidence_event_ids: z.array(z.string()).default([]),
});

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
  const { content, knownIds } = buildMaterial(store, opts.question, allowed);

  if (!engine) return record(store, opts, { deferred: true, reason: "no-engine" });
  if (!content) return record(store, opts, { deferred: true, reason: "not-enough-context" });

  const raw = await engine.extract({
    model: engine.model,
    instruction: INSTRUCTION,
    schema: answerSchema,
    content: `Question from agent "${opts.asker}":\n${opts.question}\n\n## Evidence about the user\n${content}`,
    maxTokens: 1000,
  });
  const parsed = answerSchema.parse(raw);
  const evidence = parsed.evidence_event_ids.filter((id) => knownIds.has(id));

  if (parsed.confidence < CONFIDENCE_THRESHOLD) {
    return record(store, opts, {
      deferred: true,
      reason: "low-confidence",
      answer: parsed.answer,
      confidence: parsed.confidence,
      evidence,
    });
  }
  return record(store, opts, { deferred: false, answer: parsed.answer, confidence: parsed.confidence, evidence });
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
function buildMaterial(store: EventStore, question: string, allowed: Category[] | null): { content: string; knownIds: Set<string> } {
  const knownIds = new Set<string>();
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
      lines.push("", "## Extracted assertions");
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

  const voice = store.voice();
  if (voice.pack) lines.push("", "## How the user writes and works", voice.pack);

  return { content: lines.join("\n").trim(), knownIds };
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
