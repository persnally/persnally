#!/usr/bin/env node
// Voice-fingerprint prototype (Phase: Context Depth, docs/CONTEXT_DEPTH.md).
// Deterministic stylometry over the user's OWN Claude Code prompts — no LLM,
// no tokens, nothing leaves the machine. Proves the "richest context" thesis:
// repeated phrases, working style, emphasis, all computable locally.
//
// Usage: node experiments/voice_fingerprint.mjs [~/.claude/projects]

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ROOT = process.argv[2] || join(homedir(), ".claude", "projects");

// ── extract clean human prompts (mirrors persnallyd/src/importers/claude-code.ts) ──
function humanText(content) {
  const parts = typeof content === "string" ? [content]
    : Array.isArray(content) ? content.filter((b) => b && typeof b === "object" && b.type === "text").map((b) => b.text) : [];
  const text = parts.join("\n").replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
  if (text.startsWith("<command-") || text.startsWith("<local-command") || text.startsWith("[Request interrupted")) return "";
  return text;
}
// Blocks the client injects into the user's turn. The closing tag is matched by
// backreference to the tag that opened it: a non-greedy match to *any* closing
// tag stops at the first nested one — `</task-id>` inside `<task-notification>`
// — and the remainder of the block, including Claude Code's own API-error text,
// was being counted as the user's writing. Tag list is what actually occurs in
// ~/.claude/projects, not a guess.
const INJECTED = /<(task-notification|system-reminder|local-command-[\w-]+|command-[\w-]+|bash-input|bash-stdout|bash-stderr|user-prompt-submit-hook)\b[^>]*>[\s\S]*?<\/\1>/g;

function stripInjected(t) {
  let prev;
  do { prev = t; t = t.replace(INJECTED, " "); } while (t !== prev);
  return t;
}

// Keep only prose the human actually wrote. Strips injected blocks, fenced code,
// and pasted data (paths, URLs, JSON, logs) that otherwise swamp the voice signal.
const FUNCTION_WORD = /\b(the|a|an|i|to|and|is|it|you|we|that|this|of|for|in|on|do|are|be|can|should|need|want|make|how|what|why|let|so|but|not|just|with|like|now|also)\b/;
function prose(t) {
  t = stripInjected(t.replace(/```[\s\S]*?```/g, " "))
       .replace(/<\/?[a-z][^>]*>/gi, " ");
  const kept = [];
  for (let ln of t.split("\n")) {
    ln = ln.replace(/https?:\/\/\S+/g, " ").replace(/(?:[~\w.\-]+)?(?:\/[\w.\-]+){2,}\/?/g, " ").trim();
    if (!ln) continue;
    const words = ln.split(/\s+/);
    if (words.length < 2) continue;
    const letters = (ln.match(/[a-zA-Z]/g) || []).length;
    if (letters / ln.length < 0.6) continue;            // data-ish (json, logs, ids)
    if (!FUNCTION_WORD.test(" " + ln.toLowerCase() + " ")) continue; // no function word → not a sentence
    kept.push(ln);
  }
  return kept.join("\n").trim();
}
function collectPrompts(root) {
  if (!existsSync(root)) { console.error(`No transcripts at ${root}`); process.exit(1); }
  const prompts = [];
  let sessions = 0;
  for (const project of readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const dir = join(root, project.name);
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".jsonl"))) {
      sessions++;
      for (const line of readFileSync(join(dir, f), "utf-8").split("\n")) {
        if (!line.trim()) continue;
        let e; try { e = JSON.parse(line); } catch { continue; }
        if (e.type !== "user" || e.isMeta || e.isSidechain || "toolUseResult" in e) continue;
        const t = prose(humanText(e.message?.content));
        if (t) prompts.push(t);
      }
    }
  }
  return { prompts, sessions };
}

const STOP = new Set(("a an the and or but if then so of to in on for with at by from as is are was were be been being this that these those it its it's i you he she we they me my your our their them us do does did done have has had having will would can could should may might must not no yes are't don't can't won't what which who whom whose when where why how all any both each few more most other some such only own same than too very just about into over after before above below up down out off again further once here there both i'm i've you're we're they're im ive").split(/\s+/));
const DIRECTIVE = new Set("make fix add remove create give check use keep build write update ensure confirm let lets do run show change implement refactor delete set move find get take generate review test verify explain tell help put start stop send pull push merge commit".split(" "));
const HEDGE = ["maybe", "i think", "probably", "perhaps", "kind of", "sort of", "i guess", "might be", "not sure", "i feel"];

function tokenize(s) { return (s.toLowerCase().match(/[a-z0-9][a-z0-9']*/g) || []); }
function topN(map, n, min = 1) {
  return [...map.entries()].filter(([, c]) => c >= min).sort((a, b) => b[1] - a[1]).slice(0, n);
}
function median(xs) { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }

const { prompts, sessions } = collectPrompts(ROOT);
if (!prompts.length) { console.error("No human prompts found."); process.exit(1); }

const uni = new Map(), bi = new Map(), tri = new Map(), quad = new Map();
const wordSet = new Set();
let totalWords = 0, sentCount = 0, qSent = 0, exclSent = 0, hedgeSent = 0, dirSent = 0;
const sentLens = [], promptLens = [];
let emoji = 0, allcaps = new Map(), lowerI = 0, upperI = 0, please = 0, bullets = 0, codeFences = 0;
const EMOJI = /\p{Extended_Pictographic}/gu;

for (const p of prompts) {
  emoji += (p.match(EMOJI) || []).length;
  codeFences += (p.match(/```/g) || []).length;
  for (const m of p.match(/\b[A-Z]{3,}\b/g) || []) allcaps.set(m, (allcaps.get(m) || 0) + 1);
  lowerI += (p.match(/(?:^|\s)i(?:'|\s|$)/g) || []).length;
  upperI += (p.match(/(?:^|\s)I(?:'|\s|$)/g) || []).length;
  for (const ln of p.split("\n")) if (/^\s*[-*•]\s/.test(ln)) bullets++;

  const words = tokenize(p);
  promptLens.push(words.length);
  totalWords += words.length;
  words.forEach((w) => { wordSet.add(w); if (!STOP.has(w) && w.length >= 4 && !/^\d+$/.test(w)) uni.set(w, (uni.get(w) || 0) + 1); });
  for (let i = 0; i < words.length - 1; i++) bi.set(words[i] + " " + words[i + 1], (bi.get(words[i] + " " + words[i + 1]) || 0) + 1);
  for (let i = 0; i < words.length - 2; i++) { const g = words.slice(i, i + 3).join(" "); tri.set(g, (tri.get(g) || 0) + 1); }
  for (let i = 0; i < words.length - 3; i++) { const g = words.slice(i, i + 4).join(" "); quad.set(g, (quad.get(g) || 0) + 1); }

  for (const raw of p.match(/[^.!?\n]+[.!?]*/g) || []) {
    const s = raw.trim(); if (!s) continue;
    sentCount++;
    const sw = tokenize(s); if (sw.length) sentLens.push(sw.length);
    if (/\?\s*$/.test(s)) qSent++;
    if (/!\s*$/.test(s)) exclSent++;
    const low = " " + s.toLowerCase() + " ";
    if (HEDGE.some((h) => low.includes(" " + h + " ") || low.includes(h))) hedgeSent++;
    if (sw[0] && DIRECTIVE.has(sw[0])) dirSent++;
    if (low.includes(" please ") || low.includes(" thanks") || low.includes("thank you")) please++;
  }
}

const minP = Math.max(3, Math.round(prompts.length * 0.008));
const ttr = (wordSet.size / totalWords);
const pct = (n) => sentCount ? ((n / sentCount) * 100).toFixed(0) + "%" : "0%";

// merged distinctive phrases: prefer longer; drop a shorter gram contained in a kept longer one
const phrases = [];
const seen = [];
for (const [g, c] of [...quad.entries(), ...tri.entries()].filter(([, c]) => c >= minP).sort((a, b) => b[1] - a[1])) {
  if (seen.some((s) => s.includes(g) || g.includes(s))) continue;
  phrases.push([g, c]); seen.push(g);
  if (phrases.length >= 12) break;
}

const bar = "─".repeat(64);
const fmt = (x) => x.toLocaleString("en-US");
console.log(`\n${bar}\n  VOICE FINGERPRINT  ·  ${fmt(prompts.length)} prompts across ${fmt(sessions)} sessions\n  deterministic · local · zero tokens\n${bar}`);

console.log(`\n● REPEATED PHRASES (your tics — captured verbatim)`);
if (phrases.length) phrases.forEach(([g, c]) => console.log(`    ${String(c).padStart(4)}×  "${g}"`));
else console.log(`    (none repeated ≥${minP}× — try a larger corpus)`);

console.log(`\n● DISTINCTIVE WORDS`);
topN(uni, 18, minP).forEach(([w, c]) => process.stdout.write(`  ${w} (${c})`));
console.log("");

console.log(`\n● FREQUENT PAIRINGS`);
topN(bi, 10, minP * 2).forEach(([w, c]) => process.stdout.write(`  ${w} (${c})`));
console.log("");

console.log(`\n● STRUCTURE & TONE`);
console.log(`    median sentence        ${median(sentLens)} words   (median prompt ${median(promptLens)} words)`);
console.log(`    questions              ${pct(qSent)} of sentences`);
console.log(`    direct imperatives     ${pct(dirSent)} of sentences start with a command verb`);
console.log(`    hedging                ${pct(hedgeSent)} of sentences`);
console.log(`    exclamations           ${pct(exclSent)} of sentences`);
console.log(`    vocabulary richness    ${(ttr * 100).toFixed(1)}% unique (${fmt(wordSet.size)} / ${fmt(totalWords)} words)`);
console.log(`    politeness             ${please} please/thanks`);
console.log(`    emoji                  ${emoji} total   ·   code blocks: ${codeFences >> 1}   ·   bullet lines: ${bullets}`);
console.log(`    casing                 "i" lowercase ${lowerI}× vs "I" ${upperI}×  → ${lowerI > upperI ? "casual (lowercases i)" : "standard"}`);
if (allcaps.size) console.log(`    CAPS emphasis          ${topN(allcaps, 6, 2).map(([w, c]) => `${w}(${c})`).join("  ") || "—"}`);

// ── deterministic "voice pack" draft — the serving payoff ──
const pack = [];
const ms = median(sentLens);
pack.push(ms <= 11 ? "terse, short sentences" : ms >= 18 ? "writes in long, detailed sentences" : "medium-length sentences");
if (dirSent / sentCount > 0.18) pack.push("direct — leads with imperatives, not preamble");
if (hedgeSent / sentCount < 0.05) pack.push("rarely hedges; states things flatly");
if (emoji / prompts.length < 0.02) pack.push("no emoji");
if (lowerI > upperI) pack.push("casual register (lowercases 'i')");
if (please < prompts.length * 0.05) pack.push("skips pleasantries");
if (phrases.length) pack.push(`recurring phrasing: ${phrases.slice(0, 3).map(([g]) => `"${g}"`).join(", ")}`);

console.log(`\n${bar}\n  → DRAFT "voice" PACK  (what would be injected into your tools)\n${bar}`);
console.log(`  Write like this user: ${pack.join("; ")}.`);
console.log(`\n${bar}\n`);
