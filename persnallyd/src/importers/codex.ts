/**
 * Codex transcript importer — `~/.codex/sessions/<year>/<month>/<day>/rollout-*.jsonl`
 * holds local session logs, in the same rollout format across the CLI, the
 * desktop app, and the IDE extension. Every shape here was read out of real
 * rollout files on a machine that has used Codex, since the shape of a
 * `custom_tool_call`'s `input` (a JS-code blob calling `tools.exec_command`,
 * not a clean JSON object) is not something a spec would predict.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { anthropicExtract, DEFAULT_EXTRACT_MODEL, type LlmExtract } from "../llm.js";
import { safeIso } from "../events.js";
import { projectKey } from "./claude-code.js";
import { extractEvents, type ImportResult, type ParsedConversation, type ParsedExport } from "./extract.js";

export const DEFAULT_CODEX_SESSIONS_DIR = join(homedir(), ".codex", "sessions");
export const DEFAULT_MAX_SESSIONS = 200;
const MIN_USER_MESSAGES = 2;

/**
 * Synthetic content the app injects into a `user_message` turn under the
 * user's own role — plugin ads, `<environment_context>`, and an attachment
 * wrapper that quotes the user's text back inside a "Files mentioned" header
 * rather than sending it plain. None of it is something the user typed, and
 * unlike Claude Code's `<system-reminder>` blocks these have no closing tag to
 * strip around — the whole message is the injection, so the whole message is
 * dropped rather than partially salvaged.
 */
function isInjectedUserText(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith("<recommended_plugins")
    || t.startsWith("<environment_context")
    || t.startsWith("# Files mentioned by the user:");
}

/**
 * The shell command inside a `custom_tool_call` named `exec`. Its `input` is
 * not JSON — it's a JS snippet the model wrote, calling
 * `tools.exec_command({"cmd": "...", ...})`, sometimes several times via
 * `Promise.all`. Regex-extracted rather than parsed: there is no grammar to
 * parse against, and a miss here just means less signal, not wrong signal.
 */
function execCommands(input: string): string[] {
  const out: string[] = [];
  const re = /"cmd"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  for (const m of input.matchAll(re)) {
    try {
      const cmd = JSON.parse(`"${m[1]}"`) as string;
      if (cmd.trim()) out.push(cmd);
    } catch {
      // A regex match that isn't valid JSON string content once wrapped in
      // quotes is not a command worth guessing at.
    }
  }
  return out;
}

interface ParsedSession {
  conversation: ParsedConversation | null;
  createdAtMs: number;
}

function parseSession(path: string): ParsedSession {
  let cwd = "";
  let sessionId = "";
  let createdAtMs = 0;
  let isSubagent = false;
  const userMessages: string[] = [];
  const assistantMessages: string[] = [];
  const toolCommands: string[] = [];

  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    // A session still being written, or crashed mid-line, can leave a
    // truncated tail — skip it, keep the rest.
    try { entry = JSON.parse(line) as Record<string, unknown>; } catch { continue; }

    const type = entry.type;
    const payload = entry.payload as Record<string, unknown> | undefined;

    if (type === "session_meta" && payload) {
      if (!sessionId && typeof payload.id === "string") sessionId = payload.id;
      if (!cwd && typeof payload.cwd === "string") cwd = payload.cwd;
      if (!createdAtMs) {
        const ts = typeof payload.timestamp === "string" ? payload.timestamp : entry.timestamp;
        const ms = new Date(ts as string).getTime();
        if (Number.isFinite(ms)) createdAtMs = ms;
      }
      // A "guardian" safety-review thread judging the agent's own actions —
      // its "user" turns are the parent transcript being fed in for review,
      // not the human. Importing it would credit the human with prompts they
      // never wrote. Same exclusion Claude Code applies to sidechains.
      if (payload.thread_source === "subagent") isSubagent = true;
      continue;
    }
    if (isSubagent) continue;

    if (type === "event_msg" && payload) {
      if (payload.type === "user_message" && typeof payload.message === "string") {
        if (!isInjectedUserText(payload.message)) {
          const text = payload.message.trim();
          if (text) userMessages.push(text);
        }
        continue;
      }
      if (payload.type === "agent_message" && typeof payload.message === "string") {
        const text = payload.message.trim();
        if (text) assistantMessages.push(text);
        continue;
      }
      continue;
    }

    if (type === "response_item" && payload?.type === "custom_tool_call" && payload.name === "exec") {
      const input = payload.input;
      if (typeof input === "string") toolCommands.push(...execCommands(input));
    }
  }

  if (isSubagent || userMessages.length < MIN_USER_MESSAGES) return { conversation: null, createdAtMs };

  return {
    createdAtMs,
    conversation: {
      uuid: sessionId || basename(path, ".jsonl"),
      name: cwd ? `Codex session in ${basename(cwd)}` : "Codex session",
      project: cwd ? projectKey(cwd) : undefined,
      summary: "",
      created_at: createdAtMs ? safeIso(createdAtMs) : safeIso(undefined),
      userMessages,
      assistantMessages,
      toolCommands,
    },
  };
}

/** `~/.codex/session_index.jsonl` maps a top-level thread id to the title
    Codex's own UI shows for it — subagent sub-threads aren't listed, and
    older installs may not have the file at all. Best-effort only: a missing
    or unreadable index falls back to the generated name, same as a session
    whose id has no entry. */
function loadThreadNames(sessionsDir: string): Map<string, string> {
  const names = new Map<string, string>();
  const indexPath = join(sessionsDir, "..", "session_index.jsonl");
  if (!existsSync(indexPath)) return names;
  try {
    for (const line of readFileSync(indexPath, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const { id, thread_name: name } = JSON.parse(line) as { id?: unknown; thread_name?: unknown };
        if (typeof id === "string" && typeof name === "string" && name.trim()) names.set(id, name.trim());
      } catch {
        continue;
      }
    }
  } catch {
    // Unreadable index — every session falls back to its generated name.
  }
  return names;
}

function findRolloutFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(join(entry.parentPath, entry.name));
  }
  return out;
}

export interface CodexParse {
  parsed: ParsedExport;
  sessionsFound: number;
  sessionsDropped: number; // beyond maxSessions — most recent are kept
}

export function parseCodexTranscripts(
  root: string = DEFAULT_CODEX_SESSIONS_DIR,
  maxSessions: number = DEFAULT_MAX_SESSIONS,
): CodexParse {
  if (!existsSync(root)) throw new Error(`No Codex transcripts at ${root}`);
  const names = loadThreadNames(root);
  const sessions: { conversation: ParsedConversation; createdAtMs: number }[] = [];

  for (const file of findRolloutFiles(root)) {
    // Nothing about this format is a published schema (see the module docstring
    // — `custom_tool_call.input` is a JS snippet, not JSON). One rollout file
    // that doesn't match what `parseSession` expects — a future Codex version,
    // a file half-written when the app crashed — must not cost every other
    // session its import. A per-line JSON.parse failure inside parseSession is
    // already handled; this is the file-level backstop for whatever isn't.
    let result: ReturnType<typeof parseSession>;
    try {
      result = parseSession(file);
    } catch {
      continue;
    }
    if (!result.conversation) continue;
    const named = names.get(result.conversation.uuid);
    sessions.push({
      conversation: named ? { ...result.conversation, name: named } : result.conversation,
      createdAtMs: result.createdAtMs,
    });
  }

  sessions.sort((a, b) => b.createdAtMs - a.createdAtMs);
  const kept = sessions.slice(0, maxSessions);
  return {
    parsed: { conversations: kept.map((s) => s.conversation), memoryText: "", projects: [] },
    sessionsFound: sessions.length,
    sessionsDropped: sessions.length - kept.length,
  };
}

export async function extractCodexEvents(
  parsed: ParsedExport,
  extract: LlmExtract = anthropicExtract,
  model = DEFAULT_EXTRACT_MODEL,
  file: string = DEFAULT_CODEX_SESSIONS_DIR,
  onProgress?: (done: number, total: number) => void,
): Promise<ImportResult> {
  return extractEvents(parsed, { source: "import:codex", importer: "codex", file, onProgress }, extract, model);
}
