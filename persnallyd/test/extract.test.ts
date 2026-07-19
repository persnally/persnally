import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import { extractEvents, type ParsedExport } from "../src/importers/extract.js";
import type { LlmExtract } from "../src/llm.js";

const OPTS = { source: "import:claude", importer: "claude", file: "conversations.json" };

const uuidOf = (e: { provenance: unknown }) =>
  (e.provenance as { conversation_uuid?: string }).conversation_uuid;

const topic = (name: string) => ({
  topic: name, weight: 0.5, intent: "building", sentiment: "neutral",
  depth: "moderate", category: "technology", entities: [],
});

function exportWith(n: number): ParsedExport {
  return {
    conversations: Array.from({ length: n }, (_, i) => ({
      uuid: `c${i}`, name: `Convo ${i}`, summary: "",
      created_at: "2026-01-01T00:00:00Z",
      userMessages: [`talking about subject number ${i} in plain prose today.`],
    })),
    memoryText: "",
    projects: [],
  };
}

test("extraction runs concurrently, bounded by the limit", async () => {
  const resolvers: ((v: unknown) => void)[] = [];
  const extract: LlmExtract = () => new Promise((res) => { resolvers.push(res); });

  const done = extractEvents(exportWith(8), OPTS, extract, "m", 3);
  await tick();
  assert.equal(resolvers.length, 3); // exactly `concurrency` calls in flight, not all 8

  resolvers[0]!({ topics: [] });
  await tick();
  assert.equal(resolvers.length, 4); // a freed slot starts the next conversation

  for (let i = 1; i < resolvers.length; i++) {
    resolvers[i]!({ topics: [] });
    await tick();
  }
  assert.equal(resolvers.length, 8);
  const result = await done;
  assert.equal(result.conversationsProcessed, 8);
});

test("events keep conversation order even when completions arrive out of order", async () => {
  const resolvers: ((v: unknown) => void)[] = [];
  const extract: LlmExtract = () => new Promise((res) => { resolvers.push(res); });

  const done = extractEvents(exportWith(3), OPTS, extract, "m", 3);
  await tick();
  assert.equal(resolvers.length, 3);
  for (const i of [2, 0, 1]) resolvers[i]!({ topics: [topic(`t${i}`)] }); // reverse-ish completion

  const { events } = await done;
  const topics = events.filter((e) => e.type === "signal.topic");
  assert.deepEqual(topics.map((e) => (e.payload as { topic: string }).topic), ["t0", "t1", "t2"]);
  assert.deepEqual(topics.map(uuidOf), ["c0", "c1", "c2"]);
});

test("one failed conversation doesn't abort the rest under concurrency", async () => {
  const extract: LlmExtract = async ({ content }) => {
    if (content.includes("Convo 1")) throw new Error("model returned garbage");
    const i = /subject number (\d+)/.exec(content)![1];
    return { topics: [topic(`t${i}`)] };
  };

  const { events } = await extractEvents(exportWith(3), OPTS, extract, "m", 3);
  const topics = events.filter((e) => e.type === "signal.topic");
  assert.deepEqual(topics.map((e) => (e.payload as { topic: string }).topic), ["t0", "t2"]);
  // no conversation_uuid marker for the failure → the next pass retries it
  assert.ok(!topics.some((e) => uuidOf(e) === "c1"));
});

test("PERSNALLY_IMPORT_CONCURRENCY caps in-flight extractions", async (t) => {
  process.env.PERSNALLY_IMPORT_CONCURRENCY = "1";
  t.after(() => { delete process.env.PERSNALLY_IMPORT_CONCURRENCY; });

  const resolvers: ((v: unknown) => void)[] = [];
  const extract: LlmExtract = () => new Promise((res) => { resolvers.push(res); });

  const done = extractEvents(exportWith(3), OPTS, extract, "m");
  await tick();
  assert.equal(resolvers.length, 1); // serial when the env says so

  for (let i = 0; i < resolvers.length; i++) {
    resolvers[i]!({ topics: [] });
    await tick();
  }
  await done;
});
