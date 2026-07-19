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

const MAX_CONVO_CHARS = 30_000;
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
  opts: { source: string; importer: string; file: string },
  extract: LlmExtract = anthropicExtract,
  model = DEFAULT_EXTRACT_MODEL,
  concurrency = importConcurrency(),
): Promise<ImportResult> {
  const batch = uuidv7();
  const events: PersnallyEvent[] = [];
  const voiceCorpus: string[] = []; // clean prose for the deterministic voice fingerprint

  const jobs: { convo: ParsedConversation; text: string }[] = [];
  for (const convo of parsed.conversations) {
    if (!convo.userMessages.length) continue;
    const joined = convo.userMessages.join("\n");
    voiceCorpus.push(...proseLines(joined)); // prose feeds the deterministic voice fingerprint even if topic extraction fails
    const text = stripNoise(joined).slice(0, MAX_CONVO_CHARS); // strip pasted paths/URLs/logs before the LLM sees it
    if (!text) continue;
    jobs.push({ convo, text });
  }

  // Extraction calls run concurrently (each conversation is independent); events
  // are appended in conversation order below, so output is identical to a serial run.
  const topicsPerConvo = await mapBounded(jobs, concurrency, async ({ convo, text }) => {
    try {
      const result = await extract({
        model,
        instruction:
          "Extract 1-5 topic signals from this conversation's user messages. Weight = centrality, depth = engagement level, sentiment = user's attitude toward the topic. Capture decisions and rejected options as their own signals.",
        schema: topicsExtraction,
        content: `Conversation title: ${convo.name}\n\nUser messages:\n${text}`,
      });
      return topicsExtraction.parse(result).topics;
    } catch (e) {
      // One malformed extraction (e.g. the model returns an out-of-enum value)
      // must not abort a whole multi-conversation import. Skip it — leaving no
      // conversation_uuid marker, so the next pass retries it — and keep the rest.
      console.error(`extract: skipped "${convo.name}" — ${(e instanceof Error ? e.message : String(e)).split("\n")[0]}`);
      return [];
    }
  });

  jobs.forEach(({ convo }, i) => {
    for (const t of topicsPerConvo[i]!) {
      events.push(newEvent("signal.topic", opts.source, t,
        { kind: "import", batch, file: opts.file, conversation_uuid: convo.uuid },
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
    ...(span.length ? { source_span: [span[0]!, span[span.length - 1]!] } : {}),
  }, { kind: "import", batch, file: opts.file }));

  return { events, batch, conversationsProcessed: parsed.conversations.length };
}
