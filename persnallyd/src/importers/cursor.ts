/**
 * Cursor chat history importer.
 *
 * Cursor was a *connect* target (`connect.ts` writes its MCP config) but not an
 * *import* source, so a Cursor-primary developer imported nothing but git —
 * every prompt they'd ever written to an AI was invisible to their own context
 * engine. Chat history lives in a local SQLite database Cursor writes for its
 * own UI, `state.vscdb`, never intended as an export format: composer (chat)
 * metadata in a `composerHeaders` table, and every message body in a generic
 * `cursorDiskKV` blob store keyed `composerData:<id>` / `bubbleId:<composerId>:<bubbleId>`.
 * Reverse-engineered from a real database rather than from documentation, since
 * none is published.
 */

import Database from "better-sqlite3";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { anthropicExtract, DEFAULT_EXTRACT_MODEL, type LlmExtract } from "../llm.js";
import { extractEvents, type ImportResult, type ParsedConversation, type ParsedExport } from "./extract.js";
import { projectKey } from "./claude-code.js";

/** Exported so tests can build a fixture tree at the exact path this module
    will look for it — a hand-duplicated path here and in a test drifts apart
    silently on whichever platform the test wasn't run on. */
export function cursorUserDir(home: string): string {
  if (process.platform === "darwin") return join(home, "Library", "Application Support", "Cursor", "User");
  if (process.platform === "win32") return join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "Cursor", "User");
  return join(home, ".config", "Cursor", "User");
}

export function defaultCursorDb(home: string = homedir()): string {
  return join(cursorUserDir(home), "globalStorage", "state.vscdb");
}

function workspaceStorageDir(home: string): string {
  return join(cursorUserDir(home), "workspaceStorage");
}

/** Below this, a composer is noise — an accidental open, an autocomplete blip. */
const MIN_USER_MESSAGES = 2;
/** Composers processed per import, most-recently-updated first. Bounds a single
    run against a machine with years of Cursor history: each composer costs a
    JSON parse per message, and most of that history is stale. */
export const DEFAULT_MAX_COMPOSERS = 200;

interface ComposerHeader {
  composerId: string;
  workspaceId: string;
  createdAt: number;
  lastUpdatedAt: number;
}

interface Bubble {
  type?: number; // 1 = user, 2 = assistant. Others (tool-only turns, etc.) are skipped.
  text?: string;
  toolFormerData?: { name?: string; rawArgs?: string; params?: string };
}

/**
 * Cursor tool names carry a version suffix that changes across releases —
 * `run_terminal_cmd` and `run_terminal_command_v2` were both seen in the same
 * install, on different sessions. Matched by prefix so the next `_v3` does not
 * silently stop being recognized.
 */
const TERMINAL_TOOL = /^run_terminal_command(_v\d+)?$|^run_terminal_cmd$/;

/** The `folder` a workspace was opened on, or undefined for one Cursor never
    recorded a path for (a fresh window, or an id this machine no longer has
    workspaceStorage for — expected for a workspace closed and pruned). */
function resolveProjectPath(home: string, workspaceId: string): string | undefined {
  const file = join(workspaceStorageDir(home), workspaceId, "workspace.json");
  if (!existsSync(file)) return undefined;
  try {
    const { folder } = JSON.parse(readFileSync(file, "utf-8")) as { folder?: unknown };
    if (typeof folder !== "string" || !folder.startsWith("file://")) return undefined;
    return fileURLToPath(folder);
  } catch {
    return undefined;
  }
}

/** The command Cursor's agent actually ran. `rawArgs`/`params` are each a JSON
    *string*, not a nested object, and which one carries the payload has moved
    between tool versions — `rawArgs` was empty on the `_v2` call that had it
    in `params` instead. Read whichever one parses to a `command`. */
function terminalCommand(b: Bubble): string | undefined {
  if (!b.toolFormerData?.name || !TERMINAL_TOOL.test(b.toolFormerData.name)) return undefined;
  for (const raw of [b.toolFormerData.rawArgs, b.toolFormerData.params]) {
    if (!raw) continue;
    try {
      const { command } = JSON.parse(raw) as { command?: unknown };
      if (typeof command === "string" && command.trim()) return command;
    } catch {
      continue;
    }
  }
  return undefined;
}

export interface CursorParse {
  parsed: ParsedExport;
  composersFound: number;
  composersDropped: number; // beyond maxComposers — most recent are kept
}

/**
 * Parses Cursor's local chat database. Opened read-only: this file is Cursor's
 * own live UI state, not an export, and a running Cursor may have it open under
 * WAL — a write from here is not a risk worth taking for a read-only feature.
 */
export function parseCursorHistory(
  dbPath: string = defaultCursorDb(),
  home: string = homedir(),
  maxComposers: number = DEFAULT_MAX_COMPOSERS,
): CursorParse {
  if (!existsSync(dbPath)) throw new Error(`No Cursor chat history at ${dbPath}`);
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const headers = db
      .prepare("SELECT composerId, workspaceId, createdAt, lastUpdatedAt FROM composerHeaders")
      .all() as ComposerHeader[];
    headers.sort((a, b) => (b.lastUpdatedAt || b.createdAt) - (a.lastUpdatedAt || a.createdAt));
    const kept = headers.slice(0, maxComposers);
    const keptIds = new Set(kept.map((h) => h.composerId));

    // A `composerId:` prefix check on the raw key before JSON.parse, so a
    // dropped composer's bubbles are never even parsed — the cost that matters
    // on a machine with years of history.
    const composerData = new Map<string, { name?: string; fullConversationHeadersOnly?: { bubbleId: string; type: number }[] }>();
    for (const row of db.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'").iterate() as Iterable<{ key: string; value: string }>) {
      const id = row.key.slice("composerData:".length);
      if (!keptIds.has(id)) continue;
      try { composerData.set(id, JSON.parse(row.value)); } catch { /* a corrupt row is skipped, not fatal */ }
    }

    const bubbleById = new Map<string, Bubble>(); // "composerId:bubbleId" -> bubble
    for (const row of db.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:%'").iterate() as Iterable<{ key: string; value: string }>) {
      const [, composerId] = row.key.split(":");
      if (!composerId || !keptIds.has(composerId)) continue;
      try { bubbleById.set(row.key.slice("bubbleId:".length), JSON.parse(row.value)); } catch { /* skip */ }
    }

    const conversations: ParsedConversation[] = [];
    for (const h of kept) {
      const data = composerData.get(h.composerId);
      const order = data?.fullConversationHeadersOnly ?? [];
      const userMessages: string[] = [];
      const assistantMessages: string[] = [];
      const toolCommands: string[] = [];
      for (const ref of order) {
        const b = bubbleById.get(`${h.composerId}:${ref.bubbleId}`);
        if (!b) continue;
        const text = (b.text ?? "").trim();
        if (b.type === 1 && text) userMessages.push(text);
        else if (b.type === 2 && text) assistantMessages.push(text);
        const cmd = terminalCommand(b);
        if (cmd) toolCommands.push(cmd);
      }
      if (userMessages.length < MIN_USER_MESSAGES) continue;

      const project = resolveProjectPath(home, h.workspaceId);
      conversations.push({
        uuid: h.composerId,
        name: data?.name?.trim() || (project ? `Cursor session in ${project.split("/").pop()}` : "Cursor session"),
        project: project ? projectKey(project) : undefined,
        summary: "",
        created_at: new Date(h.createdAt).toISOString(),
        userMessages,
        assistantMessages,
        toolCommands,
      });
    }

    return {
      parsed: { conversations, memoryText: "", projects: [] },
      composersFound: headers.length,
      composersDropped: headers.length - kept.length,
    };
  } finally {
    db.close();
  }
}

export async function extractCursorEvents(
  parsed: ParsedExport,
  extract: LlmExtract = anthropicExtract,
  model = DEFAULT_EXTRACT_MODEL,
  file: string = defaultCursorDb(),
  onProgress?: (done: number, total: number) => void,
): Promise<ImportResult> {
  return extractEvents(parsed, { source: "import:cursor", importer: "cursor", file, onProgress }, extract, model);
}
