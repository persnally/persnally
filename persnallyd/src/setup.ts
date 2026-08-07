/**
 * One-command onboarding: find exports (zipped or unzipped), pick an engine,
 * import everything, synthesize, connect AI clients, open the dashboard.
 * Idempotent — already-imported sources are recorded in config and skipped.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, openSync, readSync, closeSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "./config.js";

export type ExportKind = "claude" | "chatgpt";

export interface FoundExport {
  kind: ExportKind;
  path: string;     // dir or conversations.json, ready to import
  origin: string;   // what the user recognizes (zip path or dir) — also the idempotency key
  cleanup?: string; // temp dir to remove after import
}

function sniffKind(conversationsJson: string): ExportKind | null {
  // 64 KB: the discriminating key can sit past a large first record (esp. ChatGPT).
  const fd = openSync(conversationsJson, "r");
  let head: string;
  try {
    const buf = Buffer.alloc(65536);
    const n = readSync(fd, buf, 0, buf.length, 0);
    head = buf.toString("utf-8", 0, n);
  } finally {
    closeSync(fd); // always close, even if readSync throws
  }
  if (head.includes('"chat_messages"')) return "claude";
  if (head.includes('"mapping"')) return "chatgpt";
  return null;
}

function zipHasConversations(zipPath: string): boolean {
  try {
    return execFileSync("unzip", ["-l", zipPath], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] })
      .includes("conversations.json");
  } catch (e) {
    // Only reached on a genuine read failure (unzip missing, corrupt archive,
    // permission denied) — an ordinary non-matching zip never throws here, so
    // this can't spam on unrelated Downloads clutter. Surface it: a real export
    // failing silently is the worst onboarding failure mode there is.
    console.error(`persnally: couldn't read ${zipPath} (${e instanceof Error ? e.message : String(e)}) — skipping`);
    return false;
  }
}

/** Scans a directory (default ~/Downloads) for Claude/ChatGPT exports, zipped or not. */
export function detectExports(searchDir = join(homedir(), "Downloads")): FoundExport[] {
  if (!existsSync(searchDir)) return [];
  const found: FoundExport[] = [];

  for (const entry of readdirSync(searchDir, { withFileTypes: true })) {
    const full = join(searchDir, entry.name);
    if (entry.isDirectory() && existsSync(join(full, "conversations.json"))) {
      const kind = sniffKind(join(full, "conversations.json"));
      if (kind) found.push({ kind, path: full, origin: full });
    } else if (entry.isFile() && entry.name.endsWith(".zip") && zipHasConversations(full)) {
      const tmp = mkdtempSync(join(tmpdir(), "persnally-export-"));
      execFileSync("unzip", ["-q", full, "-d", tmp]);
      const root = existsSync(join(tmp, "conversations.json"))
        ? tmp
        : readdirSync(tmp).map((d) => join(tmp, d)).find((d) => existsSync(join(d, "conversations.json")));
      const kind = root ? sniffKind(join(root, "conversations.json")) : null;
      if (root && kind) found.push({ kind, path: root, origin: full, cleanup: tmp });
      else rmSync(tmp, { recursive: true, force: true });
    }
  }
  return found;
}

// ── Density floor: never leave the user with an empty mirror ──

import { z } from "zod";
import { newEvent, PAYLOAD_SCHEMAS, type PersnallyEvent } from "./events.js";
import type { ChosenExtractor } from "./llm.js";

const THIN_SIGNAL_THRESHOLD = 15;

export const DENSITY_QUESTIONS = [
  "What are you working on right now?",
  "What topics or technologies do you care most about these days?",
] as const;

export function isThin(signalCount: number): boolean {
  return signalCount < THIN_SIGNAL_THRESHOLD;
}

const seedExtraction = z.object({ topics: z.array(PAYLOAD_SCHEMAS["signal.topic"]) });

/** Turns free-text answers into seed events — via the engine when available,
 *  else a deterministic phrase split so the key-free path still works. */
export async function eventsFromAnswers(
  answers: string[],
  engine: ChosenExtractor | null,
): Promise<PersnallyEvent[]> {
  if (!answers.join("").replace(/[^a-zA-Z0-9]/g, "")) return [];
  const text = answers.map((a, i) => `${DENSITY_QUESTIONS[i] ?? "Q"}: ${a}`).join("\n");

  if (engine) {
    const result = await engine.extract({
      model: engine.model,
      instruction:
        "The user answered two onboarding questions about themselves. Extract 2-6 topic signals. Weight by how central each seems; intent 'building' for active work, 'learning'/'researching' for interests.",
      schema: seedExtraction,
      content: text,
    });
    return seedExtraction.parse(result).topics.map((t) =>
      newEvent("signal.topic", "cli", t, { kind: "local", surface: "cli" }),
    );
  }

  // Key-free fallback: comma/and-separated phrases become moderate signals.
  const phrases = answers
    .flatMap((a) => a.split(/,|\band\b|;/))
    .map((p) => p.trim())
    .filter((p) => p.length > 2 && p.length < 80 && /[a-zA-Z0-9]/.test(p))
    .slice(0, 8);
  return phrases.map((topic, i) =>
    newEvent("signal.topic", "cli", {
      topic,
      weight: 0.6,
      intent: i === 0 ? "building" : "discussing",
      sentiment: "neutral",
      depth: "moderate",
      category: "other",
      entities: [],
    }, { kind: "local", surface: "cli" }),
  );
}

export function alreadyImported(origin: string): boolean {
  const sources = loadConfig().imported_sources;
  return Array.isArray(sources) && sources.includes(origin);
}

export function markImported(origin: string): void {
  const sources = loadConfig().imported_sources;
  const list = Array.isArray(sources) ? (sources as string[]) : [];
  if (!list.includes(origin)) saveConfig({ imported_sources: [...list, origin] });
}

/** Content hashes of memory/projects snapshots already extracted from, so a
    re-import re-reads memory only when it has actually grown. */
export function importedMemoryHashes(): Set<string> {
  const h = loadConfig().imported_memory_hashes;
  return new Set(Array.isArray(h) ? (h as string[]) : []);
}

export function markMemoryImported(hash: string): void {
  if (!hash) return;
  const list = [...importedMemoryHashes()];
  if (list.includes(hash)) return;
  // Bounded: only the most recent snapshots matter for "has this changed?".
  saveConfig({ imported_memory_hashes: [...list, hash].slice(-20) });
}

// ── Conversation import, shared by `setup` and POST /import ──

import { extractChatGPTEvents, parseChatGPTExport } from "./importers/chatgpt.js";
import { extractClaudeEvents, parseClaudeExport } from "./importers/claude.js";
import {
  DEFAULT_TRANSCRIPTS_DIR, extractClaudeCodeEvents, parseClaudeCodeTranscripts,
} from "./importers/claude-code.js";
import type { EventStore } from "./store.js";

/** Setup caps transcripts so onboarding stays fast; `import claude-code` takes the rest. */
export const SETUP_TRANSCRIPT_LIMIT = 50;

export interface ImportAllResult {
  events: number;
  imported: string[]; // human labels of sources actually imported
  skipped: string[];  // sources present but skipped for want of an engine
}

/**
 * Imports every conversation source not already recorded in config: Claude and
 * ChatGPT exports found on disk, plus local Claude Code transcripts.
 *
 * Shared deliberately. Setup used to be the only caller and simply skipped this
 * work when no engine existed, so a user who configured one afterwards (the
 * dashboard's Ollama one-click, or pasting a key) got a profile synthesized
 * from git alone and was never told their chat history had been passed over.
 * Returning `skipped` lets both callers say what's still missing instead of
 * reporting success — and a skipped source is deliberately NOT marked
 * imported, so the later run actually picks it up.
 */
export async function importAllSources(
  store: EventStore,
  engine: ChosenExtractor | null,
  opts: {
    transcriptLimit?: number;
    onProgress?: (label: string) => void;
    /** Per-conversation ticks during extraction — the long pole of an import. */
    onTick?: (done: number, total: number) => void;
    /** Overridable so tests don't depend on the real ~/Downloads and ~/.claude. */
    downloadsDir?: string;
    transcriptsDir?: string;
  } = {},
): Promise<ImportAllResult> {
  const limit = opts.transcriptLimit ?? SETUP_TRANSCRIPT_LIMIT;
  const note = opts.onProgress ?? (() => {});
  const transcriptsDir = opts.transcriptsDir ?? DEFAULT_TRANSCRIPTS_DIR;
  const out: ImportAllResult = { events: 0, imported: [], skipped: [] };

  for (const found of detectExports(opts.downloadsDir)) {
    const label = `${found.kind} export (${found.origin})`;
    try {
      if (alreadyImported(found.origin)) continue;
      if (!engine) { out.skipped.push(label); continue; }
      note(`Importing ${label}`);
      const parsed = found.kind === "claude" ? parseClaudeExport(found.path) : parseChatGPTExport(found.path);
      const result = found.kind === "claude"
        ? await extractClaudeEvents(parsed, engine.extract, engine.model, opts.onTick)
        : await extractChatGPTEvents(parsed, engine.extract, engine.model, opts.onTick);
      store.append(result.events);
      markImported(found.origin);
      out.events += result.events.length;
      out.imported.push(label);
    } finally {
      // Unzipped exports land in a temp dir — remove it even if extraction threw.
      if (found.cleanup) rmSync(found.cleanup, { recursive: true, force: true });
    }
  }

  if (existsSync(transcriptsDir) && !alreadyImported(transcriptsDir)) {
    if (!engine) {
      out.skipped.push("Claude Code transcripts");
    } else {
      const { parsed, sessionsFound, sessionsDropped } = parseClaudeCodeTranscripts(transcriptsDir, limit);
      if (parsed.conversations.length) {
        note(
          `Importing Claude Code transcripts: ${parsed.conversations.length} session(s)` +
          (sessionsDropped ? ` (most recent of ${sessionsFound} — full history: persnally import claude-code)` : ""),
        );
        const result = await extractClaudeCodeEvents(parsed, engine.extract, engine.model, transcriptsDir, opts.onTick);
        store.append(result.events);
        markImported(transcriptsDir);
        out.events += result.events.length;
        out.imported.push("Claude Code transcripts");
      }
    }
  }

  if (out.events) store.rebuild();
  return out;
}
