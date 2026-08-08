/**
 * Deterministic voice refresh — re-derive the stylometry fingerprint from local
 * Claude Code transcripts and replace the prior stylometry signals in place.
 * Offline, no LLM. Shared by the CLI `voice` command and the daemon's
 * synthesize/reflect paths so "how you write" stays current and clean.
 */

import { existsSync } from "node:fs";
import { newEvent } from "./events.js";
import { DEFAULT_TRANSCRIPTS_DIR, parseClaudeCodeTranscripts } from "./importers/claude-code.js";
import { proseLines } from "./prose.js";
import { analyzeVoice } from "./stylometry.js";
import type { EventStore } from "./store.js";

export interface VoiceRefresh {
  signals: number; // 0 ⇒ no transcript corpus; any existing voice is left untouched
  prompts: number;
  pack: string;
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
  const empty: VoiceRefresh = { signals: 0, prompts: 0, pack: "" };
  if (!existsSync(root)) return empty;
  let corpus: string[];
  try {
    const { parsed } = parseClaudeCodeTranscripts(root);
    corpus = parsed.conversations.flatMap((c) => proseLines(c.userMessages.join("\n")));
  } catch {
    return empty;
  }
  const v = analyzeVoice(corpus);
  if (!v.signals.length) return empty;
  // Replace only what this refresh can re-derive: prior refresh output and the
  // import-time fingerprint of these same transcripts. Stylometry from
  // claude.ai/ChatGPT exports must survive — those corpora are no longer on
  // disk, so a wipe there is permanent voice loss, not a refresh.
  store.clearStyleByBasis("stylometry", ["cli", "dashboard", "import:claude-code"]);
  store.append(v.signals.map((s) => newEvent("signal.style", surface, s, { kind: "local", surface })));
  return { signals: v.signals.length, prompts: v.prompts, pack: v.pack };
}
