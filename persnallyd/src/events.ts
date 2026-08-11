/**
 * Event types and validation — the code form of docs/EVENT_SCHEMA.md.
 * The type set is closed: unknown types fail ingestion loudly.
 */

import { z } from "zod";

export const SCHEMA_VERSION = 1;

const intent = z.enum(["learning", "building", "researching", "deciding", "discussing", "debugging"]);
const sentiment = z.enum(["positive", "negative", "neutral"]);
const depth = z.enum(["mention", "moderate", "deep"]);
const category = z.enum([
  "technology", "business", "finance", "career", "health",
  "science", "creative", "education", "lifestyle", "news", "other",
]);

export const PAYLOAD_SCHEMAS = {
  "signal.topic": z.object({
    topic: z.string().min(1),
    weight: z.number().min(0).max(1),
    intent,
    sentiment,
    depth,
    category,
    entities: z.array(z.string()).default([]),
  }),
  "signal.assertion": z.object({
    claim: z.string().min(1),
    kind: z.enum(["fact", "preference", "behavior", "skill", "context"]),
    confidence: z.number().min(0).max(1),
    evidence: z.string(),
  }),
  "signal.skill": z.object({
    skill: z.string().min(1),
    domain: z.string(),
    proficiency: z.number().min(0).max(1),
    basis: z.string(),
  }),
  // How the user writes/works — the prescriptive layer (docs/CONTEXT_DEPTH.md).
  // Structured so it dedupes by `pattern` and consolidates into stable constants.
  "signal.style": z.object({
    dimension: z.enum(["voice", "convention", "emphasis", "format", "workflow"]),
    pattern: z.string().min(1),
    polarity: z.enum(["does", "avoids", "prefers", "insists"]),
    confidence: z.number().min(0).max(1),
    evidence: z.string(),
    basis: z.enum(["observed", "stylometry", "correction"]),
  }),
  "context.read": z.object({
    scope: z.string(),
    client_purpose: z.string(),
    items: z.number().int().nonnegative(),
  }),
  "agent.question": z.object({
    question: z.string().min(1),
    asker: z.string(),
  }),
  "agent.answer": z.object({
    question_id: z.string(),
    answer: z.string(),
    confidence: z.number().min(0).max(1),
    deferred: z.boolean(),
    // What the answer rested on. Without this the audit trail can't show the
    // evidence the answer claimed at the time; defaulted so answers recorded
    // before it existed still parse.
    evidence_event_ids: z.array(z.string()).default([]),
  }),
  "feedback.signal": z.object({
    subject_id: z.string(),
    verdict: z.enum(["approved", "edited", "vetoed"]),
  }),
  "user.correction": z.object({
    target_id: z.string(),
    action: z.enum(["delete", "edit", "contradict"]),
    reason: z.string().default(""),
  }),
  "system.import": z.object({
    importer: z.string(),
    batch: z.string(),
    events: z.number().int().nonnegative(),
    source_span: z.tuple([z.string(), z.string()]).optional(),
    /** Which extraction pipeline produced this batch. Lets a later, better
        extractor identify what it can usefully re-run (see `import --reextract`).
        Optional: batches imported before versioning carry none. */
    extractor_version: z.number().int().positive().optional(),
  }),
} as const;

export type EventType = keyof typeof PAYLOAD_SCHEMAS;
export const EVENT_TYPES = Object.keys(PAYLOAD_SCHEMAS) as EventType[];

export const provenanceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("mcp"), client: z.string(), session: z.string().optional() }),
  z.object({
    kind: z.literal("import"),
    batch: z.string(),
    file: z.string(),
    conversation_uuid: z.string().optional(),
    message_uuid: z.string().optional(),
  }),
  z.object({ kind: z.literal("git"), repo: z.string(), ref: z.string().optional(), batch: z.string().optional() }),
  z.object({ kind: z.literal("derived"), from: z.array(z.string()).min(1) }),
  z.object({ kind: z.literal("local"), surface: z.enum(["cli", "dashboard"]) }),
]);

const sourcePattern = /^(mcp:[a-z0-9._-]+|import:(claude-code|claude|chatgpt|git)|cli|dashboard|system)$/;

export const eventSchema = z.object({
  id: z.string().uuid(),
  ts: z.string().datetime({ offset: true }),
  recorded_at: z.string().datetime({ offset: true }),
  source: z.string().regex(sourcePattern),
  type: z.enum(EVENT_TYPES as [EventType, ...EventType[]]),
  payload: z.record(z.string(), z.unknown()),
  provenance: provenanceSchema,
  schema_ver: z.literal(SCHEMA_VERSION),
});

export type PersnallyEvent = z.infer<typeof eventSchema>;
export type Provenance = z.infer<typeof provenanceSchema>;

/** Validates envelope and type-specific payload. Throws ZodError on violation. */
export function validateEvent(raw: unknown): PersnallyEvent {
  const event = eventSchema.parse(raw);
  PAYLOAD_SCHEMAS[event.type].parse(event.payload);
  return event;
}

export function newEvent(
  type: EventType,
  source: string,
  payload: Record<string, unknown>,
  provenance: Provenance,
  occurredAt?: string,
): PersnallyEvent {
  const now = new Date().toISOString();
  return validateEvent({
    id: uuidv7(),
    ts: occurredAt ?? now,
    recorded_at: now,
    source,
    type,
    payload,
    provenance,
    schema_ver: SCHEMA_VERSION,
  });
}

/** UUIDv7: 48-bit ms timestamp + random — time-ordered ids that merge cleanly across devices. */
export function uuidv7(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const ts = BigInt(Date.now());
  for (let i = 0; i < 6; i++) bytes[i] = Number((ts >> BigInt(8 * (5 - i))) & 0xffn);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A valid ISO timestamp from an untrusted value (import dates), or now if it
    can't be parsed — `new Date(junk).toISOString()` throws, which would crash
    a whole import mid-batch after paying for earlier extractions. */
export function safeIso(value: unknown): string {
  const d = new Date(value as string | number);
  return Number.isFinite(d.getTime()) ? d.toISOString() : new Date().toISOString();
}

/** Topic normalization, carried over from v1's interest engine (proven merge rules). */
export function normalizeTopic(topic: string): string {
  let key = topic.toLowerCase().trim();
  for (const fw of ["node", "next", "vue", "react", "three", "angular", "nuxt", "ember"]) {
    key = key.replace(new RegExp(`\\b${fw}[.\\s]?js\\b`, "g"), `${fw}js`);
  }
  key = key.replace(/\.js\b/g, "js").replace(/\.ts\b/g, "ts");
  key = key.replace(/\bc\+\+/g, "cpp").replace(/\bc#/g, "csharp").replace(/\bf#/g, "fsharp");
  key = key.replace(/[^a-z0-9\s-]/g, "").replace(/\s+/g, "_");
  return key;
}
