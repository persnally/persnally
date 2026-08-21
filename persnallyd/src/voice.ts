/**
 * Deterministic voice refresh — re-derive the stylometry fingerprint from local
 * Claude Code transcripts and replace the prior stylometry signals in place.
 * Offline, no LLM. Shared by the CLI `voice` command and the daemon's
 * synthesize/reflect paths so "how you write" stays current and clean.
 */

import { existsSync } from "node:fs";
import { newEvent, uuidv7 } from "./events.js";
import { DEFAULT_TRANSCRIPTS_DIR, parseClaudeCodeTranscripts } from "./importers/claude-code.js";
import { proseLines } from "./prose.js";
import { analyzeVoice } from "./stylometry.js";
import { toolConventions } from "./workflow.js";
import type { EventStore } from "./store.js";

export interface VoiceRefresh {
  signals: number; // 0 ⇒ no transcript corpus; any existing voice is left untouched
  prompts: number;
  pack: string;
  /** Workspaces that yielded their own tool conventions. */
  projects: number;
}

/**
 * Re-derive the voice from the Claude Code transcript corpus and replace the
 * stylometry-basis style signals. A no-op (returns 0 signals) when there are no
 * transcripts or no usable prose — so it never wipes an existing voice with nothing.
 */
export function refreshVoice(
  store: EventStore,
  root: string = DEFAULT_TRANSCRIPTS_DIR,
  surface: "cli" | "dashboard" = "cli",
): VoiceRefresh {
  const empty: VoiceRefresh = { signals: 0, prompts: 0, pack: "", projects: 0 };
  // One batch id for everything this refresh writes, so it is auditable in the
  // log as a single act.
  const refreshBatch = uuidv7();
  if (!existsSync(root)) return empty;
  let corpus: string[];
  try {
    const { parsed } = parseClaudeCodeTranscripts(root);
    corpus = parsed.conversations.flatMap((c) => proseLines(c.userMessages.join("\n")));
  } catch {
    return empty;
  }
  // Conventions are mined per workspace from the commands each session ran —
  // deterministic, no model. Grouped, because the same person uses pnpm in one
  // repo and npm in another, and pooling them yields a winner true of neither.
  const byProject = new Map<string, string[]>();
  try {
    const { parsed } = parseClaudeCodeTranscripts(root);
    for (const c of parsed.conversations) {
      const cmds = c.toolCommands ?? [];
      if (!cmds.length || !c.project) continue;
      byProject.set(c.project, [...(byProject.get(c.project) ?? []), ...cmds]);
    }
  } catch { /* conventions are a bonus here; a parse failure must not lose the voice refresh */ }

  const v = analyzeVoice(corpus);
  if (!v.signals.length && byProject.size === 0) return empty;
  // Replace only what this refresh can re-derive: prior refresh output and the
  // import-time fingerprint of these same transcripts. Stylometry from
  // claude.ai/ChatGPT exports must survive — those corpora are no longer on
  // disk, so a wipe there is permanent voice loss, not a refresh.
  store.clearStyleByBasis("stylometry", ["cli", "dashboard", "import:claude-code"]);
  const events = v.signals.map((s) => newEvent("signal.style", surface, s, { kind: "local", surface }));
  let projects = 0;
  for (const [project, cmds] of byProject) {
    const mined = toolConventions(cmds);
    if (!mined.length) continue;
    projects++;
    for (const s of mined) {
      events.push(newEvent("signal.style", `import:claude-code`, s, {
        kind: "import", batch: refreshBatch, file: root, project,
      }));
    }
  }
  store.append(events);
  return { signals: events.length, prompts: v.prompts, pack: v.pack, projects };
}
