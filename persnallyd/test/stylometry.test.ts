import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { proseLines, stripNoise } from "../src/prose.js";
import { analyzeVoice, assemblePack } from "../src/stylometry.js";
import { newEvent, PAYLOAD_SCHEMAS } from "../src/events.js";
import { EventStore } from "../src/store.js";

test("stripNoise removes paths, URLs, code fences, and injected blocks; keeps prose", () => {
  const t = stripNoise(
    "please check the auth flow\nhttps://github.com/x/y\n/Users/me/projects/app/src/index.ts\n```secret code```\n<task-notification>noise</task-notification>",
  );
  assert.match(t, /please check the auth flow/);
  assert.doesNotMatch(t, /github\.com/);
  assert.doesNotMatch(t, /Users\/me|index\.ts/);
  assert.doesNotMatch(t, /task-notification|noise|secret code/);
});

test("proseLines keeps sentences, drops json/paths/single-word lines", () => {
  const lines = proseLines('can you fix this bug\n{"a":1,"b":2,"c":3,"d":4}\n/var/log/app/output.txt\nyes');
  assert.deepEqual(lines, ["can you fix this bug"]);
});

test("proseLines drops machine/agent noise (rate-limit notices, tool output)", () => {
  const lines = proseLines(
    "lets ship the launch today\n" +
    "failed you've hit your usage limit\nyour session limit resets at 2am Asia/Calcutta\ncompleted exit code 0",
  );
  assert.deepEqual(lines, ["lets ship the launch today"]);
});

test("analyzeVoice never claims subject matter is a preference", () => {
  // Repeated wording says what someone works on, not how they want to be
  // treated. These are verbatim from a real store, where the old phrase miner
  // emitted every one of them as something the user "insists" on.
  const msgs = Array.from({ length: 30 }, () =>
    "monitor event ci review comments for prs 123 and 124. check the dev registry deployment. and try to be quick.",
  );
  const v = analyzeVoice(msgs);
  const emphasis = v.signals.filter((s) => s.dimension === "emphasis");
  assert.deepEqual(emphasis, [], "subject-matter n-grams came back as preferences");
  // The tone signals it can actually justify still land.
  assert.ok(v.signals.some((s) => s.dimension === "voice" || s.dimension === "format"));
});


test("analyzeVoice surfaces terse tone and builds a valid pack", () => {
  const msgs = Array.from({ length: 20 }, () => "be 100% sure about the analysis. fix it now.");
  const v = analyzeVoice(msgs);
  assert.ok(v.signals.some((s) => /terse/.test(s.pattern)), "detects terse short sentences");
  assert.match(v.pack, /^Write like this user:/);
  for (const s of v.signals) PAYLOAD_SCHEMAS["signal.style"].parse(s); // every signal is schema-valid
});

test("an extractor-observed emphasis still reaches the voice pack", () => {
  // Removing the n-gram miner must not close the dimension: the extractor's
  // judged instructions are the ones worth serving.
  const pack = assemblePack([
    { dimension: "voice", pattern: "terse — short, declarative sentences", polarity: "does", confidence: 0.85, evidence: "median 8", basis: "stylometry" },
    { dimension: "emphasis", pattern: "wants the actual culprit identified with evidence", polarity: "insists", confidence: 0.9, evidence: "recurring", basis: "observed" },
  ]);
  assert.match(pack, /recurring phrasing/);
  assert.match(pack, /actual culprit/);
});


test("assemblePack lists tone first, then recurring phrasing", () => {
  const pack = assemblePack([
    { dimension: "voice", pattern: "terse", polarity: "does", confidence: 0.8, evidence: "x", basis: "stylometry" },
    { dimension: "emphasis", pattern: "be 100% sure", polarity: "insists", confidence: 0.9, evidence: "10×", basis: "stylometry" },
  ]);
  assert.match(pack, /terse/);
  assert.match(pack, /recurring phrasing.*be 100% sure/);
});

const dir = mkdtempSync(join(tmpdir(), "voice-store-"));
after(() => rmSync(dir, { recursive: true, force: true }));

test("store.voice dedups by pattern (newest wins) and orders richest first", () => {
  const store = new EventStore(join(dir, "t.db"));
  const sig = (pattern: string, confidence: number, ts: string) =>
    newEvent("signal.style", "import:claude-code",
      { dimension: "voice", pattern, polarity: "does", confidence, evidence: "x", basis: "stylometry" },
      { kind: "import", batch: "b", file: "f" }, ts);
  store.append([
    sig("terse", 0.6, "2026-06-01T00:00:00.000Z"),
    sig("terse", 0.9, "2026-06-10T00:00:00.000Z"), // newer → should win
    sig("no emoji", 0.7, "2026-06-05T00:00:00.000Z"),
  ]);
  const v = store.voice();
  const terse = v.items.filter((i) => i.pattern === "terse");
  assert.equal(terse.length, 1, "deduped by pattern");
  assert.equal(terse[0]!.confidence, 0.9, "newest occurrence wins");
  assert.equal(v.items[0]!.pattern, "terse", "highest confidence first");
  assert.match(v.pack, /Write like this user/);
  store.close();
});

test("forgetStyle deletes the pattern and tombstones it so it never resurfaces", () => {
  const store = new EventStore(join(dir, "forget.db"));
  const sig = newEvent("signal.style", "import:claude-code",
    // basis "observed": an emphasis signal from stylometry is what serving now
    // filters out, and this test is about the tombstone, not that filter.
    { dimension: "emphasis", pattern: "be 100% sure", polarity: "insists", confidence: 0.9, evidence: "10x", basis: "observed" },
    { kind: "import", batch: "b", file: "f" });
  store.append([sig]);
  assert.equal(store.voice().items.length, 1);

  const deleted = store.forgetStyle("emphasis", "be 100% sure");
  assert.equal(deleted, 1, "the matching event was deleted");
  assert.equal(store.voice().items.length, 0, "forgotten pattern excluded from voice()");

  // Re-observing the SAME pattern later (e.g. a re-import or live capture) must
  // not resurrect it — the correction is permanent, matching "deletable for real".
  store.append([newEvent("signal.style", "mcp:cursor",
    { dimension: "emphasis", pattern: "be 100% sure", polarity: "insists", confidence: 0.95, evidence: "again", basis: "observed" },
    { kind: "mcp", client: "cursor" })]);
  assert.equal(store.voice().items.length, 0, "tombstone survives re-observation");
  store.close();
});

test("pruneStyle bounds the backlog to the richest signals per pattern", () => {
  const store = new EventStore(join(dir, "prune.db"));
  const sig = (pattern: string, confidence: number) =>
    newEvent("signal.style", "mcp:cursor", { dimension: "voice", pattern, polarity: "does", confidence, evidence: "x", basis: "observed" }, { kind: "mcp", client: "cursor" });
  store.append(Array.from({ length: 50 }, (_, i) => sig(`p-${i}`, i / 100)));
  const pruned = store.pruneStyle(10);
  assert.equal(pruned, 40, "drops everything beyond the cap");
  assert.equal(store.query({ type: "signal.style", limit: 1000 }).length, 10);
  assert.ok(store.voice().items.every((it) => Number(it.pattern.split("-")[1]) >= 40), "kept the highest-confidence patterns");
  store.close();
});
