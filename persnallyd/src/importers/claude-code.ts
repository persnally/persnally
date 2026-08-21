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

/**
 * Stable identity for a workspace: the absolute path, normalized. A path can't
 * collide, where a short name can — "website" is three different repos here,
 * and "apps/web" is every monorepo. A git worktree folds back into its repo so
 * reviewing a PR isn't a separate project. Display shortening is a render-time
 * concern, not an identity one (see projectLabel).
 */
export function projectKey(cwd: string): string {
  const cut = cwd.replace(/\/+$/, "").split(/\/(?:\.claude-worktrees|worktrees)\//)[0];
  return cut || cwd;
}

/** Short label for a project path — the last segment, or the last two when that
    segment is a generic monorepo folder that would read the same everywhere. */
export function projectLabel(key: string): string {
  const parts = key.split("/").filter(Boolean);
  const last = parts[parts.length - 1] ?? key;
  const generic = new Set(["web", "app", "apps", "src", "packages", "server", "client", "api", "www"]);
  return generic.has(last) && parts.length > 1 ? parts.slice(-2).join("/") : last;
}
export const DEFAULT_MAX_SESSIONS = 200;
const MIN_USER_MESSAGES = 2;
// A resumed session tops up only once this many new messages have accrued —
// the daemon ticks every 30 min, and re-extracting an active session one
// message at a time would pay for the same context over and over.
const MIN_TOPUP_MESSAGES = 2;

/** A parsed session with per-message metadata, so resumed sessions can be
    diffed against the watermark recorded at their last import. Ids/timestamps
    are parallel to `userMessages` ("" where the transcript line had none). */
export interface SessionConversation extends ParsedConversation {
  messageIds: string[];
  messageTimestamps: string[];
}

export interface ClaudeCodeParse {
  parsed: ParsedExport & { conversations: SessionConversation[] };
  sessionsFound: number;
  sessionsDropped: number; // beyond maxSessions — most recent are kept
}

export function parseClaudeCodeTranscripts(
  root: string = DEFAULT_TRANSCRIPTS_DIR,
  maxSessions: number = DEFAULT_MAX_SESSIONS,
): ClaudeCodeParse {
  if (!existsSync(root)) throw new Error(`No Claude Code transcripts at ${root}`);
  const sessions: SessionConversation[] = [];
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

function parseSession(path: string): SessionConversation | null {
  let title = "";
  let cwd = "";
  let firstTs = "";
  let sessionId = "";
  const userMessages: string[] = [];
  const assistantMessages: string[] = [];
  const toolCommands: string[] = [];
  const messageIds: string[] = [];
  const messageTimestamps: string[] = [];

  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    // A crashed session can leave a truncated tail line — skip it, keep the rest.
    try { entry = JSON.parse(line) as Record<string, unknown>; } catch { continue; }

    if (entry.type === "ai-title" && typeof entry.aiTitle === "string") { title = entry.aiTitle; continue; }
    // Assistant prose only: the text blocks, never the tool_use blocks beside
    // them (those are #120's territory and would be noise here).
    if (entry.type === "assistant" && !entry.isSidechain) {
      const content = (entry.message as Record<string, unknown> | undefined)?.content;
      const reply = textBlocks(content);
      if (reply) assistantMessages.push(reply);
      toolCommands.push(...bashCommands(content));
      continue;
    }
    if (entry.type !== "user" || entry.isMeta || entry.isSidechain || "toolUseResult" in entry) continue;

    if (!firstTs && typeof entry.timestamp === "string") firstTs = entry.timestamp;
    if (!cwd && typeof entry.cwd === "string") cwd = entry.cwd;
    if (!sessionId && typeof entry.sessionId === "string") sessionId = entry.sessionId;

    const text = textBlocks((entry.message as Record<string, unknown> | undefined)?.content);
    if (text) {
      userMessages.push(text);
      messageIds.push(typeof entry.uuid === "string" ? entry.uuid : "");
      messageTimestamps.push(typeof entry.timestamp === "string" ? entry.timestamp : "");
    }
  }

  if (!userMessages.length) return null;
  const lastId = messageIds[messageIds.length - 1];
  return {
    uuid: sessionId || basename(path, ".jsonl"),
    name: title || (cwd ? `Claude Code session in ${basename(cwd)}` : "Claude Code session"),
    project: cwd ? projectKey(cwd) : undefined,
    summary: "",
    created_at: firstTs || new Date().toISOString(),
    userMessages,
    assistantMessages,
    toolCommands,
    messageIds,
    messageTimestamps,
    // No per-message ids (older transcript shapes) ⇒ no watermark ⇒ the session
    // imports whole and never tops up, same as before this existed.
    ...(lastId ? { lastMessageId: lastId } : {}),
  };
}

/** Shell commands the session actually ran. The convention signal — which
    package manager, which test runner, rebase or merge — lives here, and these
    blocks were previously dropped wholesale. */
function bashCommands(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: unknown; name?: unknown; input?: unknown };
    if (b.type !== "tool_use" || b.name !== "Bash") continue;
    const cmd = (b.input as { command?: unknown } | undefined)?.command;
    if (typeof cmd === "string" && cmd.trim()) out.push(cmd);
  }
  return out;
}

/** The text blocks of a message — used for both roles. Drops slash-command
    palettes, interrupts, and injected reminders. */
function textBlocks(content: unknown): string {
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
  toppedUp: number; // resumed sessions that contributed messages past their watermark
  events: number;
  skipped: number; // sessions already in the store with nothing new past the watermark
  /** The engine failed outright, so nothing was marked as imported. The caller
      must back off: these sessions will otherwise be retried on every tick. */
  engineFailed: boolean;
}

/** The suffix of a resumed session past its watermark, as its own conversation:
    same uuid (topics attribute to the session), timestamped at the first new
    message so decay treats the activity as current, watermark advanced. */
function topUpOf(c: SessionConversation, from: number): SessionConversation {
  const messageIds = c.messageIds.slice(from);
  return {
    ...c,
    userMessages: c.userMessages.slice(from),
    messageIds,
    messageTimestamps: c.messageTimestamps.slice(from),
    created_at: c.messageTimestamps[from] || c.created_at,
    lastMessageId: messageIds[messageIds.length - 1] || c.lastMessageId,
  };
}

/**
 * Import the Claude Code sessions not already in the store, plus the new tail
 * of any resumed session — the path the daemon runs on its loop. New sessions
 * are matched by the conversation_uuid in each topic's provenance; resumed
 * ones (`claude --continue` appends to the same JSONL, same sessionId) are
 * diffed against the message_uuid watermark their last import recorded.
 * Sessions imported before watermarks existed can't be diffed and never top
 * up — re-importing them whole would double their signals.
 */
export async function importNewClaudeCodeSessions(
  store: EventStore,
  extract: LlmExtract,
  model = DEFAULT_EXTRACT_MODEL,
  root: string = DEFAULT_TRANSCRIPTS_DIR,
): Promise<IncrementalImport> {
  const none: IncrementalImport = { newSessions: 0, toppedUp: 0, events: 0, skipped: 0, engineFailed: false };
  if (!existsSync(root)) return none;
  const { parsed } = parseClaudeCodeTranscripts(root);
  const seen = store.importedConversationUuids("import:claude-code");
  const marks = store.conversationWatermarks("import:claude-code");

  const fresh: SessionConversation[] = [];
  const topUps: SessionConversation[] = [];
  let skipped = 0;
  for (const c of parsed.conversations) {
    if (!seen.has(c.uuid)) { fresh.push(c); continue; }
    const mark = marks.get(c.uuid);
    // No watermark (pre-watermark import) or an id no longer in the transcript
    // (rewritten/compacted file): can't tell what's new — don't pay twice.
    const at = mark ? c.messageIds.lastIndexOf(mark) : -1;
    if (at === -1 || c.messageIds.length - (at + 1) < MIN_TOPUP_MESSAGES) { skipped++; continue; }
    topUps.push(topUpOf(c, at + 1));
  }

  const jobs = [...fresh, ...topUps];
  if (!jobs.length) return { ...none, skipped };
  const { events, extractionsSucceeded, extractionsFailed } =
    await extractClaudeCodeEvents({ ...parsed, conversations: jobs }, extract, model, root);
  store.append(events);
  // Nothing extracted and something failed = the engine, not the transcripts.
  // These sessions stay unmarked and will retry, so the caller has to stop
  // calling — otherwise the same content is re-attempted every tick forever.
  const engineFailed = extractionsSucceeded === 0 && extractionsFailed > 0;
  return { newSessions: fresh.length, toppedUp: topUps.length, events: events.length, skipped, engineFailed };
}
