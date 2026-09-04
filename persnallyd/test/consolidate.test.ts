import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { loadConfig, saveConfig } from "../src/config.js";
const NO_DISK = { conventionRoots: { claudeCode: null, cursorDb: null, codex: null } };
import { runConsolidation, shouldRunNow } from "../src/consolidate.js";
import { newEvent } from "../src/events.js";
import type { LlmExtract } from "../src/llm.js";
import { EventStore } from "../src/store.js";

test("shouldRunNow: gated by hour and once-per-day", () => {
  const before = new Date("2026-06-12T02:00:00");
  const after3am = new Date("2026-06-12T03:30:00");
  assert.equal(shouldRunNow(undefined, before), false, "before 3am: no");
  assert.equal(shouldRunNow(undefined, after3am), true, "after 3am, never run: yes");
  assert.equal(shouldRunNow("2026-06-12T03:05:00.000Z", after3am), false, "already ran today: no");
  assert.equal(shouldRunNow("2026-06-11T03:05:00.000Z", after3am), true, "ran yesterday: yes");
});

const dir = mkdtempSync(join(tmpdir(), "consolidate-test-"));
const store = new EventStore(join(dir, "test.db"));
after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

const topic = (name: string) =>
  newEvent("signal.topic", "mcp:cursor", {
    topic: name, weight: 0.8, intent: "building", sentiment: "positive",
    depth: "deep", category: "technology", entities: [],
  }, { kind: "mcp", client: "cursor" });

test("without an engine: refreshes decay, emits no assertions", async () => {
  store.append([topic("rust"), topic("sqlite")]);
  const r = await runConsolidation(store, null, new Date("2026-06-12T03:00:00"), NO_DISK);
  assert.equal(r.assertions, 0);
  assert.equal(r.profileRefreshed, false);
  assert.ok(store.topics().length >= 1, "decay rebuild ran");
});

test("consolidation prunes the style backlog so live capture stays bounded", async () => {
  const d3 = mkdtempSync(join(tmpdir(), "consolidate-style-"));
  const s3 = new EventStore(join(d3, "t.db"));
  process.env.PERSNALLY_DIR = d3;
  try {
    const style = (pattern: string, confidence: number) =>
      newEvent("signal.style", "mcp:cursor", { dimension: "voice", pattern, polarity: "does", confidence, evidence: "x", basis: "observed" }, { kind: "mcp", client: "cursor" });
    s3.append(Array.from({ length: 90 }, (_, i) => style(`pattern-${i}`, i / 100)));
    const r = await runConsolidation(s3, null, new Date("2026-06-13T03:00:00"), NO_DISK);
    assert.ok(r.stylePruned >= 10, "overflow beyond the cap is pruned");
    assert.ok(s3.query({ type: "signal.style", limit: 1000 }).length <= 80, "backlog bounded to the cap");
  } finally {
    s3.close();
    delete process.env.PERSNALLY_DIR;
    rmSync(d3, { recursive: true, force: true });
  }
});

test("with engine + enough signal: emits derived behavior assertions", async () => {
  // Fresh store so last_consolidation from the previous test doesn't filter these out.
  const d2 = mkdtempSync(join(tmpdir(), "consolidate-2-"));
  const s2 = new EventStore(join(d2, "t.db"));
  process.env.PERSNALLY_DIR = d2; // config (last_consolidation) lands here
  try {
    s2.append(Array.from({ length: 6 }, (_, i) => topic(`topic-${i}`)));
    let sawSummary = "";
    const engine = {
      model: "mock", label: "mock",
      extract: async ({ content }: { content: string }) => {
        sawSummary = content;
        return { assertions: [{ claim: "deep focus on systems topics", kind: "behavior", confidence: 0.8, evidence: "6 recent deep signals" }] };
      },
    };
    const r = await runConsolidation(s2, engine, new Date("2026-06-12T03:00:00"), NO_DISK);
    assert.equal(r.newSignals, 6);
    assert.equal(r.assertions, 1);
    assert.match(sawSummary, /topic-0/);

    const derived = s2.query({ type: "signal.assertion" })[0]!;
    assert.equal(derived.provenance.kind, "derived");
    assert.equal((derived.provenance as { from: string[] }).from.length, 6);
  } finally {
    s2.close();
    delete process.env.PERSNALLY_DIR;
    rmSync(d2, { recursive: true, force: true });
  }
});

test("a failing run records the attempt but not the success watermark", async () => {
  // The bug this replaces: last_consolidation was written only on success, so a
  // persistent failure left a stale date, shouldRunNow kept returning true, and
  // the daily job retried every 30 minutes — 229 paid attempts observed on a
  // real install over 5 days.
  const cfgDir = mkdtempSync(join(tmpdir(), "consolidate-fail-"));
  const prev = process.env.PERSNALLY_DIR;
  process.env.PERSNALLY_DIR = cfgDir;
  after(() => {
    if (prev === undefined) delete process.env.PERSNALLY_DIR; else process.env.PERSNALLY_DIR = prev;
    rmSync(cfgDir, { recursive: true, force: true });
  });

  const watermark = "2026-06-11T21:30:00.000Z";
  saveConfig({ last_consolidation: watermark });
  store.append([topic("elixir"), topic("gleam"), topic("zig"), topic("ocaml"), topic("nim")]);
  store.rebuild();

  const exploding = {
    extract: (async () => { throw new Error("400 credit balance is too low"); }) as unknown as LlmExtract,
    model: "boom",
    label: "boom",
  };
  const now = new Date("2026-08-05T14:00:00");
  await assert.rejects(() => runConsolidation(store, exploding, now), /credit balance/);

  const cfg = loadConfig();
  assert.equal(cfg.last_consolidation, watermark,
    "the success watermark must not advance — signals it never consolidated would be skipped forever");
  assert.equal(cfg.last_consolidation_attempt, now.toISOString(), "but the attempt is on record");

  // And that record is what stops the 30-minute retry.
  assert.equal(shouldRunNow(cfg.last_consolidation_attempt, new Date("2026-08-05T14:30:00")), false,
    "no retry 30 minutes later");
  assert.equal(shouldRunNow(cfg.last_consolidation_attempt, new Date("2026-08-05T23:59:00")), false,
    "and none later the same day");
  assert.equal(shouldRunNow(cfg.last_consolidation_attempt, new Date("2026-08-06T03:30:00")), true,
    "tomorrow it tries again");
});

test("an upgraded install with only the old key runs once, then settles", () => {
  // Existing installs have last_consolidation but no attempt key. That must read
  // as "never attempted" so the first tick after upgrade runs.
  assert.equal(shouldRunNow(undefined, new Date("2026-08-05T14:00:00")), true);
  assert.equal(shouldRunNow("not-a-date", new Date("2026-08-05T14:00:00")), true, "unreadable state tries once");
});

test("nightly consolidation re-derives conventions from the whole command history", async () => {
  const d4 = mkdtempSync(join(tmpdir(), "consolidate-conventions-"));
  const s4 = new EventStore(join(d4, "t.db"));
  process.env.PERSNALLY_DIR = d4;
  const cc = join(d4, "claude-projects", "-Users-dev-Projects-thing");
  try {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(cc, { recursive: true });
    const base = { sessionId: "s1", cwd: "/Users/dev/Projects/thing", timestamp: "2026-08-01T10:00:00Z" };
    const lines = [
      { ...base, type: "user", uuid: "u1", message: { role: "user", content: "one" } },
      { ...base, type: "user", uuid: "u2", message: { role: "user", content: "two" } },
      ...["npm ci", "npm test", "npm run build"].map((command, i) => ({
        ...base, type: "assistant", uuid: `a${i}`,
        message: { role: "assistant", content: [{ type: "tool_use", id: `t${i}`, name: "Bash", input: { command } }] },
      })),
    ];
    writeFileSync(join(cc, "s1.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

    const r = await runConsolidation(s4, null, new Date("2026-06-14T03:00:00"),
      { conventionRoots: { claudeCode: join(d4, "claude-projects"), cursorDb: null, codex: null } });
    assert.ok(r.conventionsRefreshed > 0, "the refresh ran and derived something");
    const npm = s4.voice("/Users/dev/Projects/thing").items.find((s) => s.pattern === "uses npm");
    assert.ok(npm, "the whole-history habit is on file after the nightly pass");
  } finally {
    s4.close();
    delete process.env.PERSNALLY_DIR;
    rmSync(d4, { recursive: true, force: true });
  }
});
