/**
 * The deterministic half of "how you write and work": tone from the user's own
 * prose, conventions from the commands their sessions actually ran. No model,
 * no tokens, re-runnable.
 *
 * Conventions are derived from the *whole* command history of a workspace, not
 * from whichever sessions an import batch happened to contain. The daemon's
 * incremental imports mine only their own batch, so "uses npm" in a repo with
 * 185 npm invocations never appeared when no single top-up held three of them —
 * and with nothing observed to serve, the ask path answered from a prose claim
 * ("prefers pnpm") at 0.92 for a repo that runs npm. `refreshConventions`
 * re-derives from every local transcript source on disk and replaces the
 * fragments, after each import and nightly.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { newEvent, uuidv7 } from "./events.js";
import type { ParsedConversation } from "./importers/extract.js";
import { DEFAULT_TRANSCRIPTS_DIR, parseClaudeCodeTranscripts } from "./importers/claude-code.js";
import { DEFAULT_CODEX_SESSIONS_DIR, parseCodexTranscripts } from "./importers/codex.js";
import { defaultCursorDb, parseCursorHistory } from "./importers/cursor.js";
import type { EventStore } from "./store.js";
import { proseLines } from "./prose.js";
import { analyzeVoice } from "./stylometry.js";
import { toolConventions } from "./workflow.js";

export interface VoiceRefresh {
  signals: number; // 0 ⇒ no transcript corpus; any existing voice is left untouched
  prompts: number;
  pack: string;
  /** Workspaces that yielded their own tool conventions. */
  projects: number;
}

/**
 * Where the local transcript sources live. `undefined` = the default location,
 * `null` = skip this source (tests point at a fixture root and must not read
 * the machine's real history alongside it).
 */
export interface ConventionRoots {
  claudeCode?: string | null;
  cursorDb?: string | null;
  cursorHome?: string;
  codex?: string | null;
}

/** Every source whose convention/workflow signals a refresh re-derives and may therefore replace. */
export const CONVENTION_SOURCES = ["cli", "dashboard", "import:claude-code", "import:cursor", "import:codex"];
const CONVENTION_DIMENSIONS = ["convention", "workflow"];
const ALL_HISTORY = Number.MAX_SAFE_INTEGER;
const TONE_DIMENSIONS = ["voice", "format", "emphasis"];

/**
 * Shell commands per workspace, pooled across every local transcript source
 * on disk. A source that is absent contributes nothing; one that fails to
 * parse is reported and skipped rather than taking the others down with it.
 */
export function commandsByProjectOnDisk(roots: ConventionRoots = {}): Map<string, string[]> {
  const byProject = new Map<string, string[]>();
  const add = (conversations: ParsedConversation[]): void => {
    for (const c of conversations) {
      const cmds = c.toolCommands ?? [];
      if (!cmds.length || !c.project) continue;
      byProject.set(c.project, [...(byProject.get(c.project) ?? []), ...cmds]);
    }
  };
  const read = (label: string, path: string | null | undefined, parse: (p: string) => ParsedConversation[]): void => {
    if (path === null || !path || !existsSync(path)) return;
    try {
      add(parse(path));
    } catch (e) {
      console.error(`conventions: skipped ${label} — ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  // Unbounded on purpose. The parsers keep the newest N sessions by default,
  // which is right for an import budget and wrong here: this refresh replaces
  // every convention on file, so a habit whose evidence sits in older sessions
  // would be wiped by a bounded read. Deterministic and local, so the cost is
  // parse time, not tokens.
  read("Claude Code", roots.claudeCode === undefined ? DEFAULT_TRANSCRIPTS_DIR : roots.claudeCode,
    (p) => parseClaudeCodeTranscripts(p, ALL_HISTORY).parsed.conversations);
  read("Cursor", roots.cursorDb === undefined ? defaultCursorDb(roots.cursorHome) : roots.cursorDb,
    (p) => parseCursorHistory(p, roots.cursorHome ?? homedir(), ALL_HISTORY).parsed.conversations);
  read("Codex", roots.codex === undefined ? DEFAULT_CODEX_SESSIONS_DIR : roots.codex,
    (p) => parseCodexTranscripts(p, ALL_HISTORY).parsed.conversations);
  return byProject;
}

/**
 * Re-derive every workspace's conventions from its full command history and
 * replace the stylometry-basis convention/workflow signals with the result.
 * A no-op when no transcripts are on disk, so it never wipes conventions it
 * cannot rebuild. Live `observed` and `correction` signals are never touched.
 */
export function refreshConventions(
  store: EventStore,
  roots: ConventionRoots = {},
  surface: "cli" | "dashboard" = "cli",
): { signals: number; projects: number } {
  const byProject = commandsByProjectOnDisk(roots);
  if (byProject.size === 0) return { signals: 0, projects: 0 };
  const batch = uuidv7();
  const events = [];
  let projects = 0;
  for (const [project, cmds] of byProject) {
    const mined = toolConventions(cmds);
    if (!mined.length) continue;
    projects++;
    for (const s of mined) {
      events.push(newEvent("signal.style", surface, s, { kind: "import", batch, file: "local transcripts", project }));
    }
  }
  store.clearStyleByBasis("stylometry", CONVENTION_SOURCES, CONVENTION_DIMENSIONS);
  store.append(events);
  return { signals: events.length, projects };
}

/**
 * Re-derive the voice from the Claude Code transcript corpus and replace the
 * stylometry-basis tone signals; conventions are refreshed alongside from every
 * local source. A no-op (returns 0 signals) when there is nothing on disk — so
 * it never wipes an existing voice with nothing. When `root` points somewhere
 * other than the default transcripts directory, only that corpus is read
 * unless `roots` says otherwise: a caller that redirected one source did not
 * ask to have the machine's other history pulled in beside it.
 */
export function refreshVoice(
  store: EventStore,
  root: string = DEFAULT_TRANSCRIPTS_DIR,
  surface: "cli" | "dashboard" = "cli",
  roots?: ConventionRoots,
): VoiceRefresh {
  const empty: VoiceRefresh = { signals: 0, prompts: 0, pack: "", projects: 0 };
  let conversations: ParsedConversation[] = [];
  if (existsSync(root)) {
    try {
      conversations = parseClaudeCodeTranscripts(root).parsed.conversations;
    } catch {
      conversations = [];
    }
  }
  const corpus = conversations.flatMap((c) => proseLines(c.userMessages.join("\n")));
  const v = analyzeVoice(corpus);

  const isDefault = root === DEFAULT_TRANSCRIPTS_DIR;
  const conventions = refreshConventions(store, roots ?? {
    claudeCode: root,
    cursorDb: isDefault ? undefined : null,
    codex: isDefault ? undefined : null,
  }, surface);

  if (!v.signals.length && conventions.projects === 0) return empty;
  if (v.signals.length) {
    // Replace only what this refresh can re-derive: prior refresh output and the
    // import-time fingerprint of these same transcripts. Stylometry from
    // claude.ai/ChatGPT exports must survive — those corpora are no longer on
    // disk, so a wipe there is permanent voice loss, not a refresh.
    store.clearStyleByBasis("stylometry", ["cli", "dashboard", "import:claude-code"], TONE_DIMENSIONS);
    store.append(v.signals.map((s) => newEvent("signal.style", surface, s, { kind: "local", surface })));
  }
  return { signals: v.signals.length + conventions.signals, prompts: v.prompts, pack: v.pack, projects: conventions.projects };
}
