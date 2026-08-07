/**
 * Claude Code transcript importer — ~/.claude/projects holds JSONL session
 * logs locally: for developers a richer corpus than the claude.ai export
 * (Phase 0 finding), and available immediately with no export wait.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { anthropicExtract, DEFAULT_EXTRACT_MODEL, type LlmExtract } from "../llm.js";
import type { EventStore } from "../store.js";
import { extractEvents, type ImportResult, type ParsedConversation, type ParsedExport } from "./extract.js";

export const DEFAULT_TRANSCRIPTS_DIR = join(homedir(), ".claude", "projects");
export const DEFAULT_MAX_SESSIONS = 200;
const MIN_USER_MESSAGES = 2;

export interface ClaudeCodeParse {
  parsed: ParsedExport;
  sessionsFound: number;
  sessionsDropped: number; // beyond maxSessions — most recent are kept
}

export function parseClaudeCodeTranscripts(
  root: string = DEFAULT_TRANSCRIPTS_DIR,
  maxSessions: number = DEFAULT_MAX_SESSIONS,
): ClaudeCodeParse {
  if (!existsSync(root)) throw new Error(`No Claude Code transcripts at ${root}`);
  const sessions: ParsedConversation[] = [];
  for (const project of readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const dir = join(root, project.name);
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".jsonl"))) {
      const session = parseSession(join(dir, file));
      if (session && session.userMessages.length >= MIN_USER_MESSAGES) sessions.push(session);
    }
  }
  sessions.sort((a, b) => b.created_at.localeCompare(a.created_at));
  const kept = sessions.slice(0, maxSessions);
  return {
    parsed: { conversations: kept, memoryText: "", projects: [] },
    sessionsFound: sessions.length,
    sessionsDropped: sessions.length - kept.length,
  };
}

function parseSession(path: string): ParsedConversation | null {
  let title = "";
  let cwd = "";
  let firstTs = "";
  let sessionId = "";
  const userMessages: string[] = [];

  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    // A crashed session can leave a truncated tail line — skip it, keep the rest.
    try { entry = JSON.parse(line) as Record<string, unknown>; } catch { continue; }

    if (entry.type === "ai-title" && typeof entry.aiTitle === "string") { title = entry.aiTitle; continue; }
    if (entry.type !== "user" || entry.isMeta || entry.isSidechain || "toolUseResult" in entry) continue;

    if (!firstTs && typeof entry.timestamp === "string") firstTs = entry.timestamp;
    if (!cwd && typeof entry.cwd === "string") cwd = entry.cwd;
    if (!sessionId && typeof entry.sessionId === "string") sessionId = entry.sessionId;

    const text = humanText((entry.message as Record<string, unknown> | undefined)?.content);
    if (text) userMessages.push(text);
  }

  if (!userMessages.length) return null;
  return {
    uuid: sessionId || basename(path, ".jsonl"),
    name: title || (cwd ? `Claude Code session in ${basename(cwd)}` : "Claude Code session"),
    summary: "",
    created_at: firstTs || new Date().toISOString(),
    userMessages,
  };
}

/** Human prompt text only — drop slash-command palettes, interrupts, and injected reminders. */
function humanText(content: unknown): string {
  const parts = typeof content === "string"
    ? [content]
    : Array.isArray(content)
      ? content
          .filter((b): b is { type: string; text: string } =>
            !!b && typeof b === "object" && (b as { type?: unknown }).type === "text")
          .map((b) => b.text)
      : [];
  const text = parts
    .join("\n")
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .trim();
  if (text.startsWith("<command-") || text.startsWith("<local-command") || text.startsWith("[Request interrupted")) {
    return "";
  }
  return text;
}

export async function extractClaudeCodeEvents(
  parsed: ParsedExport,
  extract: LlmExtract = anthropicExtract,
  model = DEFAULT_EXTRACT_MODEL,
  file = DEFAULT_TRANSCRIPTS_DIR,
  onProgress?: (done: number, total: number) => void,
): Promise<ImportResult> {
  return extractEvents(parsed, { source: "import:claude-code", importer: "claude-code", file, onProgress }, extract, model);
}

export interface IncrementalImport {
  newSessions: number;
  events: number;
  skipped: number; // sessions already in the store
  /** The engine failed outright, so nothing was marked as imported. The caller
      must back off: these sessions will otherwise be retried on every tick. */
  engineFailed: boolean;
}

/**
 * Import only the Claude Code sessions not already in the store — the path the
 * daemon runs on its loop so new chats accrue without re-extracting old ones.
 * Sessions are matched by the conversation_uuid recorded in each topic's
 * provenance; a session that yields zero topics leaves no marker and may be
 * retried, which is cheap and rare (a real session produces topics).
 */
export async function importNewClaudeCodeSessions(
  store: EventStore,
  extract: LlmExtract,
  model = DEFAULT_EXTRACT_MODEL,
  root: string = DEFAULT_TRANSCRIPTS_DIR,
): Promise<IncrementalImport> {
  if (!existsSync(root)) return { newSessions: 0, events: 0, skipped: 0, engineFailed: false };
  const { parsed } = parseClaudeCodeTranscripts(root);
  const seen = store.importedConversationUuids("import:claude-code");
  const fresh = parsed.conversations.filter((c) => !seen.has(c.uuid));
  const skipped = parsed.conversations.length - fresh.length;
  if (!fresh.length) return { newSessions: 0, events: 0, skipped, engineFailed: false };
  const { events, extractionsSucceeded, extractionsFailed } =
    await extractClaudeCodeEvents({ ...parsed, conversations: fresh }, extract, model, root);
  store.append(events);
  // Nothing extracted and something failed = the engine, not the transcripts.
  // These sessions stay unmarked and will retry, so the caller has to stop
  // calling — otherwise the same content is re-attempted every tick forever.
  const engineFailed = extractionsSucceeded === 0 && extractionsFailed > 0;
  return { newSessions: fresh.length, events: events.length, skipped, engineFailed };
}
