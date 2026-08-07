/**
 * Shared extraction pipeline for conversation-export importers.
 * Parsers produce a ParsedExport; this turns it into provenance-linked events.
 */

import { readFileSync, statSync } from "node:fs";
import { z } from "zod";
import { newEvent, safeIso, uuidv7, PAYLOAD_SCHEMAS, type PersnallyEvent } from "../events.js";
import { anthropicExtract, DEFAULT_EXTRACT_MODEL, type LlmExtract } from "../llm.js";
import { proseLines, stripNoise } from "../prose.js";
import { analyzeVoice } from "../stylometry.js";

// Enough attempts to tell a bad response apart from a dead engine, few enough
// that a dead engine costs a handful of calls instead of the whole batch.
const FAILFAST_AFTER = 3;

/**
 * The extraction pipeline's version. Bump whenever a change would produce
 * materially better signals from the *same* source — a new prompt, a new model
 * default, a new signal type, more of each conversation being read.
 *
 * Re-importing is otherwise a deliberate no-op (already-imported conversations
 * are skipped by uuid), which is right for cost but meant the first import's
 * quality was permanent: a better extractor could never be applied to history
 * already on file. Stamping the version is what makes `import --reextract`
 * able to say *which* batches are worth re-running.
 *
 * v2 — extraction reads the assistant's replies too, not just the user's
 *      prompts, so it can see what was answered and decided.
 */
export const EXTRACTOR_VERSION = 2;

const MAX_CONVO_CHARS = 30_000;
// The assistant half is context, not the subject: replies run several times
// longer than prompts, so they get a smaller total budget and a per-turn head
// cap (an answer's substance is near its start).
const MAX_ASSISTANT_CHARS = 10_000;
const MAX_ASSISTANT_TURN_CHARS = 700;
const MAX_IMPORT_FILE_BYTES = 400 * 1024 * 1024; // ~400 MB — under Node's ~512 MB string cap; larger needs streaming
const DEFAULT_CONCURRENCY = 4;

/** In-flight extraction ceiling: PERSNALLY_IMPORT_CONCURRENCY, clamped to [1, 16]. */
function importConcurrency(): number {
  const n = Number(process.env.PERSNALLY_IMPORT_CONCURRENCY);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, 16) : DEFAULT_CONCURRENCY;
}

/** Maps items with at most `limit` calls in flight; results keep item order. `fn` must not throw. */
async function mapBounded<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < items.length; i = next++) {
      results[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Joins turns under a budget, keeping both ends when it doesn't fit: the start
 * establishes what the conversation was about, the end carries what was decided
 * — dropping a tail would lose exactly the conclusions worth extracting.
 */
function budgetedTurns(messages: string[], perTurn: number, total: number): string {
  const capped = messages
    .map((m) => stripNoise(m).trim())
    .filter(Boolean)
    .map((m) => (m.length > perTurn ? `${m.slice(0, perTurn)}…` : m));
  if (!capped.length) return "";
  let out = capped.join("\n");
  if (out.length <= total) return out;
  const half = Math.floor(total / 2);
  const head: string[] = [];
  const tail: string[] = [];
  let used = 0;
  for (const m of capped) {
    if (used + m.length > half) break;
    head.push(m); used += m.length;
  }
  used = 0;
  for (let i = capped.length - 1; i >= head.length; i--) {
    const m = capped[i]!;
    if (used + m.length > half) break;
    tail.unshift(m); used += m.length;
  }
  out = [...head, "…", ...tail].join("\n");
  return out;
}

/** Reads an export file, refusing oversized ones with a clear message instead of an opaque OOM/crash. */
export function readImportFile(path: string, maxBytes: number = MAX_IMPORT_FILE_BYTES): string {
  const { size } = statSync(path);
  if (size > maxBytes) {
    throw new Error(
      `${path} is ${Math.round(size / 1e6)} MB, over the ${Math.round(maxBytes / 1e6)} MB import limit. ` +
        `Very large exports aren't supported yet — import a smaller export or split conversations.json.`,
    );
  }
  return readFileSync(path, "utf-8");
}

export interface ParsedConversation {
  uuid: string;
  name: string;
  summary: string;
  created_at: string;
  userMessages: string[];
  /** The assistant's replies. Context for what the user was *told* and what got
      resolved — extraction saw only their questions before this. Never enters
      the voice corpus: stylometry is how the *user* writes. */
  assistantMessages?: string[];
  /** Id of the last message consumed, recorded as the provenance watermark so a
      resumed session can be topped up with only what came after it. */
  lastMessageId?: string;
}

export interface ParsedExport {
  conversations: ParsedConversation[];
  memoryText: string;
  projects: { name: string; description: string }[];
}

export interface ImportResult {
  events: PersnallyEvent[];
  batch: string;
  conversationsProcessed: number;
  /** Extraction outcomes. Zero succeeded with some failed means the engine is
      down, not that these conversations were unusual — callers back off on that
      rather than retrying the same content on the next tick. */
  extractionsSucceeded: number;
  extractionsFailed: number;
}

/**
 * Filters a parsed export to the conversations not already imported (matched by
 * uuid), so a re-import only adds new chats instead of doubling the graph. The
 * one-time memory/projects snapshot carries no per-conversation id, so it's kept
 * only on the first import of a source.
 */
export function freshConversations(
  parsed: ParsedExport,
  seen: Set<string>,
): { parsed: ParsedExport; skipped: number; firstImport: boolean } {
  const firstImport = seen.size === 0;
  const conversations = parsed.conversations.filter((c) => !c.uuid || !seen.has(c.uuid));
  const skipped = parsed.conversations.length - conversations.length;
  const next = firstImport
    ? { ...parsed, conversations }
    : { ...parsed, conversations, memoryText: "", projects: [] };
  return { parsed: next, skipped, firstImport };
}

const topicsExtraction = z.object({ topics: z.array(PAYLOAD_SCHEMAS["signal.topic"]) });
const assertionsExtraction = z.object({ assertions: z.array(PAYLOAD_SCHEMAS["signal.assertion"]) });

export async function extractEvents(
  parsed: ParsedExport,
  opts: { source: string; importer: string; file: string; onProgress?: (done: number, total: number) => void },
  extract: LlmExtract = anthropicExtract,
  model = DEFAULT_EXTRACT_MODEL,
  concurrency = importConcurrency(),
): Promise<ImportResult> {
  const batch = uuidv7();
  const events: PersnallyEvent[] = [];
  const voiceCorpus: string[] = []; // clean prose for the deterministic voice fingerprint

  const jobs: { convo: ParsedConversation; text: string; replies: string }[] = [];
  for (const convo of parsed.conversations) {
    if (!convo.userMessages.length) continue;
    const joined = convo.userMessages.join("\n");
    // User prose only — assistant text would corrupt the fingerprint with the
    // model's writing rather than the user's.
    voiceCorpus.push(...proseLines(joined));
    const text = stripNoise(joined).slice(0, MAX_CONVO_CHARS); // strip pasted paths/URLs/logs before the LLM sees it
    if (!text) continue;
    const replies = budgetedTurns(convo.assistantMessages ?? [], MAX_ASSISTANT_TURN_CHARS, MAX_ASSISTANT_CHARS);
    jobs.push({ convo, text, replies });
  }

  // Extraction calls run concurrently (each conversation is independent); events
  // are appended in conversation order below, so output is identical to a serial run.
  let succeeded = 0;
  let failed = 0;
  let settled = 0;
  // Extraction is the long pole of an import (minutes on a local model), so
  // report as each conversation lands rather than leaving a blank terminal.
  const done = () => opts.onProgress?.(++settled, jobs.length);
  const topicsPerConvo = await mapBounded(jobs, concurrency, async ({ convo, text, replies }) => {
    // Several failures and nothing working yet means the engine is broken — a bad
    // key, no credits, a provider outage — and every remaining call will fail the
    // same way. Stop paying for the rest of the batch.
    if (succeeded === 0 && failed >= FAILFAST_AFTER) { done(); return []; }
    try {
      const result = await extract({
        model,
        instruction:
          "Extract 1-5 topic signals from this conversation. Weight = centrality to the USER, depth = engagement level, sentiment = the user's attitude toward the topic. Capture decisions and rejected options as their own signals. " +
          "Assistant replies, when present, are context for what the user was told and what got resolved — use them to identify outcomes and what the user now knows, but never treat a topic the assistant raised on its own as one of the user's interests.",
        schema: topicsExtraction,
        content: `Conversation title: ${convo.name}\n\nUser messages:\n${text}`
          + (replies ? `\n\nAssistant replies (context only):\n${replies}` : ""),
      });
      const topics = topicsExtraction.parse(result).topics;
      succeeded++;
      done();
      return topics;
    } catch (e) {
      failed++;
      // One malformed extraction (e.g. the model returns an out-of-enum value)
      // must not abort a whole multi-conversation import. Skip it — leaving no
      // conversation_uuid marker, so the next pass retries it — and keep the rest.
      console.error(`extract: skipped "${convo.name}" — ${(e instanceof Error ? e.message : String(e)).split("\n")[0]}`);
      done();
      return [];
    }
  });

  jobs.forEach(({ convo }, i) => {
    for (const t of topicsPerConvo[i]!) {
      events.push(newEvent("signal.topic", opts.source, t,
        {
          kind: "import", batch, file: opts.file, conversation_uuid: convo.uuid,
          ...(convo.lastMessageId ? { message_uuid: convo.lastMessageId } : {}),
        },
        safeIso(convo.created_at),
      ));
    }
  });

  if (parsed.memoryText.trim() || parsed.projects.length) {
    const context = [
      parsed.memoryText.trim() && `Assistant's accumulated memory of the user:\n${parsed.memoryText}`,
      parsed.projects.length && `User-created projects:\n${parsed.projects.map((p) => `- ${p.name}: ${p.description}`).join("\n")}`,
    ].filter(Boolean).join("\n\n");
    try {
      const result = await extract({
        model,
        instruction:
          "Extract structured assertions about this person: facts, preferences, behaviors, skills, and context. Confidence reflects how directly the source supports the claim.",
        schema: assertionsExtraction,
        content: context,
      });
      const { assertions } = assertionsExtraction.parse(result);
      for (const a of assertions) {
        events.push(newEvent("signal.assertion", opts.source, a, { kind: "import", batch, file: opts.file }));
      }
    } catch (e) {
      // A malformed assertions response shouldn't discard the topics already gathered.
      console.error(`extract: skipped memory/projects assertions — ${(e instanceof Error ? e.message : String(e)).split("\n")[0]}`);
    }
  }

  // Deterministic voice fingerprint over the user's own prose — no LLM, no tokens.
  for (const s of analyzeVoice(voiceCorpus).signals) {
    events.push(newEvent("signal.style", opts.source, s, { kind: "import", batch, file: opts.file }));
  }

  const span = parsed.conversations.map((c) => c.created_at).sort();
  events.push(newEvent("system.import", "system", {
    importer: opts.importer,
    batch,
    events: events.length,
    extractor_version: EXTRACTOR_VERSION,
    ...(span.length ? { source_span: [span[0]!, span[span.length - 1]!] } : {}),
  }, { kind: "import", batch, file: opts.file }));

  return {
    events, batch,
    conversationsProcessed: parsed.conversations.length,
    extractionsSucceeded: succeeded,
    extractionsFailed: failed,
  };
}
