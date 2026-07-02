import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { startDaemon } from "../src/daemon.js";
import { newEvent } from "../src/events.js";
import { EventStore } from "../src/store.js";

const PORT = 49861;
const BASE = `http://127.0.0.1:${PORT}`;
const postJson = (path: string, body: unknown, contentType = "application/json") =>
  fetch(BASE + path, { method: "POST", headers: { "Content-Type": contentType }, body: JSON.stringify(body) });

const dir = mkdtempSync(join(tmpdir(), "daemon-ask-test-"));
const store = new EventStore(join(dir, "test.db"));
let server: ReturnType<typeof startDaemon>;

// A pre-seeded exchange so /questions and /feedback are testable without an LLM.
const question = newEvent("agent.question", "mcp:cursor",
  { question: "Would they want tests?", asker: "cursor" }, { kind: "mcp", client: "cursor" });
const answer = newEvent("agent.answer", "mcp:cursor",
  { question_id: question.id, answer: "Yes — always.", confidence: 0.9, deferred: false },
  { kind: "derived", from: [question.id] });

before(() => {
  store.append([question, answer]);
  server = startDaemon(store, PORT);
});
after(() => { server.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });

test("POST /ask rejects non-JSON content types", async () => {
  const r = await postJson("/ask", { question: "x" }, "text/plain");
  assert.equal(r.status, 415);
});

test("POST /ask requires a question", async () => {
  assert.equal((await postJson("/ask", {})).status, 400);
  assert.equal((await postJson("/ask", { question: "" })).status, 400);
  assert.equal((await postJson("/ask", { question: "x".repeat(501) })).status, 400);
});

test("GET /questions returns history with stats", async () => {
  const body = await (await fetch(`${BASE}/questions`)).json() as {
    items: Array<{ question: string; answer: string; verdict: string | null }>;
    stats: { asked: number; answered: number; precision: number | null };
  };
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0]!.question, "Would they want tests?");
  assert.equal(body.items[0]!.verdict, null);
  assert.equal(body.stats.asked, 1);
  assert.equal(body.stats.precision, null, "no labels yet → precision unknown, not 0");
});

test("POST /feedback validates verdict and answer id", async () => {
  assert.equal((await postJson("/feedback", { answer_id: answer.id, verdict: "loved-it" })).status, 400);
  assert.equal((await postJson("/feedback", { answer_id: "nope", verdict: "approved" })).status, 404);
  assert.equal((await postJson("/feedback", { answer_id: question.id, verdict: "approved" })).status, 404,
    "feedback must target an agent.answer, not any event");
  assert.equal((await postJson("/feedback", { answer_id: answer.id, verdict: "approved" }, "text/plain")).status, 415);
});

test("POST /feedback records the verdict and it lands in /questions", async () => {
  const r = await postJson("/feedback", { answer_id: answer.id, verdict: "approved" });
  assert.equal(r.status, 201);
  const body = await (await fetch(`${BASE}/questions`)).json() as {
    items: Array<{ verdict: string | null }>;
    stats: { approved: number; precision: number | null };
  };
  assert.equal(body.items[0]!.verdict, "approved");
  assert.equal(body.stats.approved, 1);
  assert.equal(body.stats.precision, 1);
});
