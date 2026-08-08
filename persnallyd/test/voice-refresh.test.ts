/**
 * refreshVoice runs nightly (consolidation) and on every /synthesize. It can
 * only re-read the Claude Code transcripts still on disk — the claude.ai and
 * ChatGPT exports it once fingerprinted are long deleted. It used to clear
 * ALL stylometry-basis style signals anyway, so any user with both an export
 * and Claude Code transcripts silently lost their export-derived voice on the
 * first nightly pass, permanently. These tests pin the boundary: replace what
 * you can re-derive, never what you can't.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { newEvent } from "../src/events.js";
import { EventStore } from "../src/store.js";
import { refreshVoice } from "../src/voice.js";

const root = mkdtempSync(join(tmpdir(), "voice-refresh-"));
const store = new EventStore(join(root, "test.db"));
after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });

const style = (pattern: string, source: string) => {
  const provenance = source.startsWith("import:")
    ? { kind: "import" as const, batch: "b1", file: "conversations.json" }
    : { kind: "local" as const, surface: "cli" as const };
  return newEvent("signal.style", source, {
    dimension: "emphasis", pattern, polarity: "insists",
    confidence: 0.9, evidence: "seen repeatedly", basis: "stylometry",
  }, provenance);
};

// A transcript corpus that reliably yields stylometry signals (same recipe as
// stylometry.test.ts: 20 repetitions of a short, distinctive prompt).
const transcripts = join(root, "projects");
mkdirSync(join(transcripts, "-x"), { recursive: true });
writeFileSync(join(transcripts, "-x", "s1.jsonl"),
  Array.from({ length: 20 }, (_, i) => JSON.stringify({
    type: "user", sessionId: "s1", uuid: `m${i}`, timestamp: "2026-08-01T10:00:00Z", cwd: "/x",
    message: { role: "user", content: "be 100% sure about the analysis. fix it now." },
  })).join("\n") + "\n");

test("refreshVoice replaces its own corpus but never export-derived voice", () => {
  store.append([
    style("from the claude export", "import:claude"),
    style("from the chatgpt export", "import:chatgpt"),
    style("from claude-code import", "import:claude-code"),
    style("from a previous refresh", "cli"),
  ]);

  const r = refreshVoice(store, transcripts, "cli");
  assert.ok(r.signals > 0, "the refresh derived a real fingerprint");

  const patterns = store.voice().items.map((s) => s.pattern);
  assert.ok(patterns.includes("from the claude export"),
    "claude.ai export voice survives — that corpus is gone from disk and can never be re-derived");
  assert.ok(patterns.includes("from the chatgpt export"), "chatgpt export voice survives");
  assert.ok(!patterns.includes("from claude-code import"),
    "claude-code-derived stylometry is replaced — the refresh re-reads those same transcripts");
  assert.ok(!patterns.includes("from a previous refresh"), "prior refresh output is replaced");
  const seeded = ["from the claude export", "from the chatgpt export", "from claude-code import", "from a previous refresh"];
  assert.ok(patterns.some((p) => !seeded.includes(p)), "the fresh derivation landed");
});

test("live-observed style is untouched by a refresh regardless of source", () => {
  const observed = newEvent("signal.style", "mcp:claude-code", {
    dimension: "convention", pattern: "prefers pnpm", polarity: "prefers",
    confidence: 0.8, evidence: "said so", basis: "observed",
  }, { kind: "mcp", client: "claude-code" });
  store.append([observed]);

  refreshVoice(store, transcripts, "cli");

  assert.ok(store.voice().items.some((s) => s.pattern === "prefers pnpm"),
    "observed signals have a different basis and must never be part of a stylometry refresh");
});
