/**
 * Profile synthesis — the Mirror. Turns the event store into a descriptive profile,
 * each section citing the event ids it rests on so "why does it think this?"
 * resolves to actual evidence.
 */

import { z } from "zod";
import { anthropicExtract, DEFAULT_PROFILE_MODEL, type LlmExtract } from "./llm.js";
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

  const content = [
    "## Weighted interests (decayed)",
    ...topics.map((t) =>
      `- [${t.event_ids[0] ?? ""}] ${t.topic} (${t.category}, weight ${t.weight.toFixed(2)}, ` +
      `${t.dominant_intent}, ${t.signals} signals${t.entities.length ? `, entities: ${t.entities.slice(0, 5).join(", ")}` : ""})`,
    ),
    "",
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
  const parsed = profileSchema.parse(raw);
  const profile: Profile = { ...parsed, generated_at: new Date().toISOString(), model };
  store.saveProfile(profile);
  return profile;
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
