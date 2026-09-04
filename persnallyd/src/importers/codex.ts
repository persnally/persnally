/**
 * Codex transcript importer — `~/.codex/sessions/<year>/<month>/<day>/rollout-*.jsonl`
 * holds local session logs, in the same rollout format across the CLI, the
 * desktop app, and the IDE extension. Every shape here was read out of real
 * rollout files on a machine that has used Codex, since the shape of a
 * `custom_tool_call`'s `input` (a JS-code blob calling `tools.exec_command`,
 * not a clean JSON object) is not something a spec would predict.
 */

import { existsSync, readdirSync, readFileSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { EventStore } from "../store.js";
import { anthropicExtract, DEFAULT_EXTRACT_MODEL, type LlmExtract } from "../llm.js";
import { safeIso } from "../events.js";
import { projectKey } from "./claude-code.js";
import { extractEvents, type ImportResult, type ParsedExport } from "./extract.js";
import { runIncrementalImport, type IncrementalImportResult, type WatermarkedConversation } from "./incremental.js";

export const DEFAULT_CODEX_SESSIONS_DIR = join(homedir(), ".codex", "sessions");
export const DEFAULT_MAX_SESSIONS = 200;
const MIN_USER_MESSAGES = 2;

/**
 * A `user_message` turn's real text, with app-injected wrapping removed.
 *
 * `<recommended_plugins>` and `<environment_context>` blocks carry nothing the
 * user typed and are dropped whole. The "Files mentioned by the user"
 * attachment wrapper is different: on real data it always ends with a
 * `## My request for Codex:` section holding the user's own freshly-typed
 * instruction for that turn — content that exists nowhere else in the
 * transcript. An earlier version of this function treated the whole wrapper
 * as synthetic and dropped it whole, which silently discarded that
 * instruction every time a user pasted reference material and then said what
 * they wanted done with it — an ordinary Codex usage pattern, verified
 * against a real session on this machine (two of four real user turns in one
 * file were this exact shape, both losing their actual request). Salvaged the
 * same way Claude Code's `<system-reminder>` stripping salvages real text
 * around a synthetic wrapper, instead of discarding the whole turn.
 */
function salvageUserText(text: string): string {
  const t = text.trim();
  if (t.startsWith("<recommended_plugins") || t.startsWith("<environment_context")) return "";
  if (t.startsWith("# Files mentioned by the user:")) {
    const marker = "## My request for Codex:";
    const idx = t.indexOf(marker);
    return idx === -1 ? "" : t.slice(idx + marker.length).trim();
  }
  return t;
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
  conversation: WatermarkedConversation | null;
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
  // Parallel to userMessages, pushed only when a message is actually kept —
  // same shape as claude-code.ts's messageIds/messageTimestamps. Every
  // user_message line carries both a client_id and an outer timestamp
  // (checked directly against real rollout files), so Codex gets the same
  // per-message precision claude-code.ts has, not cursor.ts's coarser
  // composer-level fallback.
  const messageIds: string[] = [];
  const messageTimestamps: string[] = [];

  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    // A session still being written, or crashed mid-line, can leave a
    // truncated tail — skip it, keep the rest. JSON.parse("null") succeeds
    // and returns null, which the try/catch above does not catch — every
    // field access below needs entry to actually be an object, or a single
    // `null` line throws out of this whole session instead of just itself.
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object") continue;
      entry = parsed as Record<string, unknown>;
    } catch {
      continue;
    }

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
        const text = salvageUserText(payload.message);
        if (text) {
          userMessages.push(text);
          messageIds.push(typeof payload.client_id === "string" ? payload.client_id : "");
          messageTimestamps.push(typeof entry.timestamp === "string" ? entry.timestamp : "");
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

  // An empty client_id (a message shape without one) doesn't make a
  // trustworthy watermark — only use the last one if it's real.
  const lastId = messageIds[messageIds.length - 1];

  return {
    createdAtMs,
    conversation: {
      uuid: sessionId || basename(path, ".jsonl"),
      name: cwd ? `Codex session in ${basename(cwd)}` : "Codex session",
      project: cwd ? projectKey(cwd) : undefined,
      summary: "",
      // safeIso(0) is a valid, finite date (the epoch) — not the "no
      // timestamp found anywhere in this file" case being mistaken for
      // *now*, which would hand a stale or malformed-metadata session
      // false maximum recency in the decay-weighted interest graph.
      created_at: safeIso(createdAtMs),
      userMessages,
      assistantMessages,
      toolCommands,
      messageIds,
      messageTimestamps,
      ...(lastId ? { lastMessageId: lastId } : {}),
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

/**
 * Walked by hand, one directory at a time, rather than
 * `readdirSync(root, { recursive: true })`: that call throws on the first
 * unreadable nested directory anywhere in the tree (a sandboxing artifact,
 * a sync-tool placeholder) and returns nothing at all, not a partial list —
 * killing the entire import from one bad `<year>/<month>/<day>` folder, so
 * years of otherwise-readable sessions never get a chance to be tried.
 */
function findRolloutFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(full);
    }
  };
  walk(root);
  return out;
}

export interface CodexParse {
  parsed: ParsedExport & { conversations: WatermarkedConversation[] };
  sessionsFound: number;
  sessionsDropped: number; // beyond maxSessions — most recent are kept
}

export function parseCodexTranscripts(
  root: string = DEFAULT_CODEX_SESSIONS_DIR,
  maxSessions: number = DEFAULT_MAX_SESSIONS,
): CodexParse {
  if (!existsSync(root)) throw new Error(`No Codex transcripts at ${root}`);
  const names = loadThreadNames(root);
  const sessions: { conversation: WatermarkedConversation; createdAtMs: number }[] = [];

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

/**
 * Import Codex sessions not already in the store, plus the new tail of any
 * session resumed since its last import. Thin wrapper over the shared
 * incremental engine (see incremental.ts).
 */
export async function importNewCodexSessions(
  store: EventStore,
  extract: LlmExtract,
  model = DEFAULT_EXTRACT_MODEL,
  root: string = DEFAULT_CODEX_SESSIONS_DIR,
): Promise<IncrementalImportResult> {
  if (!existsSync(root)) return { newConversations: 0, toppedUp: 0, events: 0, skipped: 0, engineFailed: false };
  return runIncrementalImport(store, {
    source: "import:codex",
    parse: () => parseCodexTranscripts(root).parsed,
    extract: (jobs) => extractCodexEvents({ conversations: jobs, memoryText: "", projects: [] }, extract, model, root),
  });
}
