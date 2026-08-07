/**
 * Profile synthesis — the Mirror. Turns the event store into a descriptive profile,
 * each section citing the event ids it rests on so "why does it think this?"
 * resolves to actual evidence.
 */

import { z } from "zod";
import { anthropicExtract, DEFAULT_PROFILE_MODEL, type LlmExtract } from "./llm.js";
import { loadScopes, type Category } from "./permissions.js";
import type { EventStore } from "./store.js";

export const profileSchema = z.object({
  headline: z.string().min(1),
  sections: z.array(
    z.object({
      title: z.string().min(1),
      body: z.string().min(1),
      evidence_event_ids: z.array(z.string()).default([]),
    }),
  ).min(1),
});

export type Profile = z.infer<typeof profileSchema> & { generated_at: string; model: string };

const INSTRUCTION = `Write the sharpest possible picture of this person from their extracted signals.

Rules:
- Cover only what the evidence supports: current work, how they think and decide, technical depth, communication style, what they care about and avoid, and non-obvious inferences the pattern reveals.
- Be specific and concrete. Where you're inferring rather than told, say so. Do not flatter.
- Every section must list the event ids (given in [brackets]) of the signals it rests on.
- The test: the person reads it and thinks "how did it know that?"`;

/**
 * The model is told to cite the ids given in brackets; nothing forces it to.
 * An invented id resolves to no event, and the dashboard renders that as
 * "evidence not found (deleted?)" — blaming the user's own deletion for our
 * fabrication, on the one surface whose entire job is being checkable. Unknown
 * ids are dropped before a profile is ever stored.
 */
export function pruneEvidence<T extends z.infer<typeof profileSchema>>(parsed: T, offered: Set<string>): T {
  let dropped = 0;
  const sections = parsed.sections.map((s) => {
    const kept = s.evidence_event_ids.filter((id) => offered.has(id));
    dropped += s.evidence_event_ids.length - kept.length;
    return { ...s, evidence_event_ids: kept };
  });
  if (dropped) {
    console.error(`persnally: dropped ${dropped} evidence id(s) the profile cited but the store does not have`);
  }
  return { ...parsed, sections };
}

export async function synthesizeProfile(
  store: EventStore,
  extract: LlmExtract = anthropicExtract,
  model: string = DEFAULT_PROFILE_MODEL,
): Promise<Profile> {
  const topics = store.topics(30);
  const assertions = store.query({ type: "signal.assertion", limit: 200 });
  if (!topics.length && !assertions.length) {
    throw new Error("Nothing to synthesize from — run an import first.");
  }
  const corrections = store.corrections(25);
  const skills = store.skills(20);

  const content = [
    "## Weighted interests (decayed)",
    ...topics.map((t) =>
      `- [${t.event_ids[0] ?? ""}] ${t.topic} (${t.category}, weight ${t.weight.toFixed(2)}, ` +
      `${t.dominant_intent}, ${t.signals} signals${t.entities.length ? `, entities: ${t.entities.slice(0, 5).join(", ")}` : ""})`,
    ),
    "",
    ...(skills.length ? [
      "## Demonstrated skills (from repos they actually commit to)",
      ...skills.map((k) => `- ${k.skill} (${k.domain}, proficiency ${k.proficiency.toFixed(2)}, ${k.sources} source(s))`),
      "",
    ] : []),
    "## Extracted assertions",
    ...assertions.map((e) => {
      const p = e.payload as { claim: string; kind: string; confidence: number; evidence: string };
      return `- [${e.id}] (${p.kind}, conf ${p.confidence}) ${p.claim} — ${p.evidence}`;
    }),
    // What the user explicitly corrected overrides anything inferred above.
    ...(corrections.length ? [
      "",
      "## Corrections stated by the user (authoritative — where these conflict with anything above, the correction wins)",
      ...corrections.map((c) => `- [${c.id}] ${c.subject ? `re ${c.subject}: ` : ""}${c.correction}`),
    ] : []),
  ].join("\n");

  const raw = await extract({
    model,
    instruction: INSTRUCTION,
    schema: profileSchema,
    content,
    maxTokens: 8000,
  });
  const offered = new Set([
    ...topics.map((t) => t.event_ids[0] ?? ""),
    ...assertions.map((e) => e.id),
    ...corrections.map((c) => c.id),
  ]);
  const parsed = pruneEvidence(profileSchema.parse(raw), offered);
  const profile: Profile = { ...parsed, generated_at: new Date().toISOString(), model };
  store.saveProfile(profile);
  return profile;
}

/** Canonical cache key for one category set — order-insensitive, deduped. */
export function scopeKey(categories: Category[]): string {
  return [...new Set(categories)].sort().join(",");
}

const SCOPED_INSTRUCTION = `Write a sharp, evidence-grounded picture of this person WITHIN the listed domains only — it will be served to an AI tool that is allowed to see just this slice of them.

Rules:
- Cover only what the evidence supports: what they work on, how they engage, and what they care about within these domains. Do not speculate about their life outside them.
- Be specific and concrete. Do not flatter.
- Every section must list the event ids (given in [brackets]) of the signals it rests on.`;

/** Synthesize a profile from ONLY the allowed categories' topics — no
    cross-category assertions, corrections, or narrative can leak through it.
    Returns null when the scope has nothing to say. */
export async function synthesizeScopedProfile(
  store: EventStore,
  allowed: Category[],
  extract: LlmExtract = anthropicExtract,
  model: string = DEFAULT_PROFILE_MODEL,
): Promise<Profile | null> {
  const topics = store.topics(1000).filter((t) => allowed.includes(t.category as Category)).slice(0, 30);
  if (!topics.length) return null;

  const content = [
    `Domains in scope: ${allowed.join(", ")}`,
    "",
    "## Weighted interests (decayed)",
    ...topics.map((t) =>
      `- [${t.event_ids[0] ?? ""}] ${t.topic} (${t.category}, weight ${t.weight.toFixed(2)}, ` +
      `${t.dominant_intent}, ${t.signals} signals${t.entities.length ? `, entities: ${t.entities.slice(0, 5).join(", ")}` : ""})`,
    ),
  ].join("\n");

  const raw = await extract({ model, instruction: SCOPED_INSTRUCTION, schema: profileSchema, content, maxTokens: 4000 });
  const offered = new Set(topics.map((t) => t.event_ids[0] ?? ""));
  const parsed = pruneEvidence(profileSchema.parse(raw), offered);
  const profile: Profile = { ...parsed, generated_at: new Date().toISOString(), model };
  store.saveScopedProfile(scopeKey(allowed), profile);
  return profile;
}

/** Re-synthesize every scope-set currently configured; prune caches whose
    scope no longer exists. Failures are per-scope — one bad synthesis never
    takes down the others or the caller. */
export async function refreshScopedProfiles(
  store: EventStore,
  extract: LlmExtract = anthropicExtract,
  model: string = DEFAULT_PROFILE_MODEL,
): Promise<{ refreshed: number; pruned: number }> {
  const active = new Set(Object.values(loadScopes()).map(scopeKey));
  let pruned = 0;
  for (const key of store.scopedProfileKeys()) {
    if (!active.has(key)) { store.deleteScopedProfile(key); pruned++; }
  }
  let refreshed = 0;
  for (const key of active) {
    try {
      if (await synthesizeScopedProfile(store, key.split(",") as Category[], extract, model)) refreshed++;
    } catch (e) {
      console.error(`scoped profile (${key}) failed:`, e instanceof Error ? e.message : e);
    }
  }
  return { refreshed, pruned };
}

export function renderProfile(p: Profile): string {
  const lines = [`# ${p.headline}`, ""];
  for (const s of p.sections) {
    lines.push(`## ${s.title}`, s.body);
    if (s.evidence_event_ids.length) lines.push(`  ↳ evidence: ${s.evidence_event_ids.length} event(s)`);
    lines.push("");
  }
  lines.push(`(generated ${p.generated_at} by ${p.model})`);
  return lines.join("\n");
}
