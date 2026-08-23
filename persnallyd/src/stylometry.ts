/**
 * Deterministic voice fingerprint — no LLM, no tokens, nothing leaves the machine.
 * Turns the user's own prose (already noise-filtered via prose.ts) into structured
 * signal.style payloads + a prescriptive "voice" pack. See docs/CONTEXT_DEPTH.md.
 */

import { z } from "zod";
import { PAYLOAD_SCHEMAS } from "./events.js";

export type StyleSignal = z.infer<(typeof PAYLOAD_SCHEMAS)["signal.style"]>;

const STOP = new Set(
  ("a an the and or but if then so of to in on for with at by from as is are was were be been being this that these those it its i you he she we they me my your our their them us do does did done have has had having will would can could should may might must not no yes what which who when where why how all any both each few more most other some such only own same than too very just about into over after before above below up down out off again once here there im ive youre were theyre lets")
    .split(/\s+/),
);
const DIRECTIVE = new Set(
  "make fix add remove create give check use keep build write update ensure confirm let lets do run show change implement refactor delete set move find get take generate review test verify explain tell help put start stop send pull push merge commit"
    .split(" "),
);
const HEDGE = ["maybe", "i think", "probably", "perhaps", "kind of", "sort of", "i guess", "might be", "not sure", "i feel"];
const EMOJI = /\p{Extended_Pictographic}/gu;

const tokenize = (s: string): string[] => s.toLowerCase().match(/[a-z0-9][a-z0-9']*/g) || [];
const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

export interface VoiceProfile {
  signals: StyleSignal[];
  words: { word: string; count: number }[]; // distinctive content words (dashboard, not stored)
  pack: string;
  prompts: number;
}

/** Compute a voice profile from prose messages (each may be multi-line). */
export function analyzeVoice(messages: string[]): VoiceProfile {
  if (!messages.length) return { signals: [], words: [], pack: "", prompts: 0 };
  const uni = new Map<string, number>();
  const sentLens: number[] = [];
  const wordSet = new Set<string>();
  let sent = 0, dir = 0, hedge = 0, emoji = 0, lowerI = 0, upperI = 0, please = 0, bulletLines = 0;

  for (const msg of messages) {
    emoji += (msg.match(EMOJI) || []).length;
    lowerI += (msg.match(/(?:^|\s)i(?:'|\s|$)/g) || []).length;
    upperI += (msg.match(/(?:^|\s)I(?:'|\s|$)/g) || []).length;
    for (const ln of msg.split("\n")) if (/^\s*[-*•]\s/.test(ln)) bulletLines++;

    const words = tokenize(msg);
    words.forEach((w) => {
      wordSet.add(w);
      if (!STOP.has(w) && w.length >= 4 && !/^\d+$/.test(w)) uni.set(w, (uni.get(w) || 0) + 1);
    });

    for (const raw of msg.match(/[^.!?\n]+[.!?]*/g) || []) {
      const s = raw.trim(); if (!s) continue;
      sent++;
      const sw = tokenize(s); if (sw.length) sentLens.push(sw.length);
      const low = " " + s.toLowerCase() + " ";
      if (HEDGE.some((h) => low.includes(h))) hedge++;
      if (sw[0] && DIRECTIVE.has(sw[0])) dir++;
      if (low.includes(" please ") || low.includes(" thanks") || low.includes("thank you")) please++;
    }
  }
  if (!sent) return { signals: [], words: [], pack: "", prompts: messages.length };

  const minP = Math.max(3, Math.round(messages.length * 0.01));
  const rate = (n: number) => n / sent;

  const signals: StyleSignal[] = [];
  const med = median(sentLens);
  const add = (dimension: StyleSignal["dimension"], pattern: string, polarity: StyleSignal["polarity"], confidence: number, evidence: string) =>
    signals.push({ dimension, pattern, polarity, confidence: Math.round(confidence * 100) / 100, evidence, basis: "stylometry" });

  // tone constants
  if (med <= 11) add("voice", "terse — short, declarative sentences", "does", 0.85, `median ${med} words/sentence`);
  else if (med >= 18) add("voice", "writes in long, detailed sentences", "does", 0.8, `median ${med} words/sentence`);
  if (rate(dir) > 0.15) add("voice", "leads with imperatives, minimal preamble", "does", 0.75, `${Math.round(rate(dir) * 100)}% of sentences open with a command verb`);
  if (rate(hedge) < 0.05) add("voice", "states things flatly; rarely hedges", "does", 0.8, `hedging in ${Math.round(rate(hedge) * 100)}% of sentences`);
  if (emoji / messages.length < 0.02) add("format", "no emoji", "avoids", 0.7, `${emoji} emoji across ${messages.length} prompts`);
  if (lowerI > upperI * 1.3) add("format", "casual register — lowercases “i”", "does", 0.7, `“i” ${lowerI}× vs “I” ${upperI}×`);
  if (please < messages.length * 0.05) add("voice", "skips pleasantries", "does", 0.6, `${please} please/thanks across ${messages.length} prompts`);
  if (bulletLines > messages.length * 0.25) add("format", "structures answers with bullet points", "prefers", 0.65, `${bulletLines} bulleted lines`);

  // No repeated-phrase mining. It was emitting raw 3- and 4-grams as things the
  // user "insists" on, and on a real 3,199-event store all 23 it produced were
  // subject matter, not preference: "monitor event ci review", "prs 123 and
  // 124", "the dev registry deployment". Repeated wording says what someone
  // works on — which signal.topic already captures, 1,953 times over — not how
  // they want to be treated. The `emphasis` dimension is still populated, by
  // the extractor that can tell an instruction from a noun phrase.

  const words = [...uni.entries()].filter(([, c]) => c >= minP).sort((a, b) => b[1] - a[1]).slice(0, 18).map(([word, count]) => ({ word, count }));
  return { signals, words, pack: assemblePack(signals), prompts: messages.length };
}

/** Build the system-prompt-ready "voice" line from style signals (shared by import + serving). */
export function assemblePack(signals: StyleSignal[]): string {
  const tone = signals.filter((s) => s.dimension !== "emphasis").map((s) => s.pattern);
  const phrases = signals.filter((s) => s.dimension === "emphasis").map((s) => `“${s.pattern}”`);
  if (!tone.length && !phrases.length) return "";
  const parts = [...tone];
  if (phrases.length) parts.push(`recurring phrasing: ${phrases.slice(0, 5).join(", ")}`);
  return `Write like this user: ${parts.join("; ")}.`;
}

/**
 * A convention as the corpus should state it: the pattern plus how much
 * behaviour backs it.
 *
 * `toolConventions` computes both the count and a confidence, and both used to
 * be dropped at serve time — so a claim a model once extracted from prose
 * ("prefers pnpm and vitest in JS", conf 0.82) was rendered *with* its
 * confidence while 625 observed npm invocations in the very project being asked
 * about were rendered as a bare bullet. The model reasonably believed the
 * numbered one. What the user does has to be at least as legible as what a
 * model once said about them.
 */
export function statedConvention(s: { pattern: string; evidence?: string }): string {
  const count = /(\d[\d,]*)\s+command/.exec(s.evidence ?? "")?.[1];
  return count ? `${s.pattern} — observed in ${count} commands here` : s.pattern;
}
