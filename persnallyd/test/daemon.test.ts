import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { startDaemon } from "../src/daemon.js";
import { newEvent } from "../src/events.js";
import { createSession, issueToken, SESSION_COOKIE } from "../src/permissions.js";
import { EventStore } from "../src/store.js";

const PORT = 49831;
const BASE = `http://127.0.0.1:${PORT}`;
// Every route needs a credential now. These suites exercise route behavior, so
// they run as the owner; the auth boundary itself is daemon.auth.test.ts.
const owner = () => ({ cookie: `${SESSION_COOKIE}=${createSession()}` });
const authed = (path: string, init: RequestInit = {}) =>
  fetch(BASE + path, { ...init, headers: { ...owner(), ...(init.headers as Record<string, string> | undefined) } });
const postJson = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  authed(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
const dir = mkdtempSync(join(tmpdir(), "daemon-test-"));
process.env.PERSNALLY_DIR = dir;       // isolate config writes (POST /engine/key) to the temp dir
delete process.env.ANTHROPIC_API_KEY;  // clean baseline for the engine-status / key tests
const store = new EventStore(join(dir, "test.db"));
let server: ReturnType<typeof startDaemon>;
let cursorToken: string;

const topicEvent = newEvent("signal.topic", "import:claude", {
  topic: "rust", weight: 0.9, intent: "building", sentiment: "positive",
  depth: "deep", category: "technology", entities: [],
}, { kind: "import", batch: "b1", file: "conversations.json" });

before(() => {
  store.append([topicEvent]);
  store.rebuild();
  server = startDaemon(store, PORT);
  cursorToken = issueToken("cursor");
});
after(() => { server.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });

test("GET / serves the dashboard", async () => {
  const r = await authed("/");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type") ?? "", /text\/html/);
  assert.match(await r.text(), /persnally/);
});

test("GET /topics returns the derived view", async () => {
  const topics = await (await authed("/topics")).json() as Array<{ topic_key: string }>;
  assert.equal(topics[0]?.topic_key, "rust");
});

test("GET /events?ids= resolves provenance lookups", async () => {
  const events = await (await authed(`/events?ids=${topicEvent.id},missing`)).json() as Array<{ id: string }>;
  assert.equal(events.length, 1);
  assert.equal(events[0]?.id, topicEvent.id);
});

test("POST /events validates and rejects garbage", async () => {
  const r = await postJson("/events", { type: "signal.bogus" });
  assert.equal(r.status, 400);
});

test("GET /profile is 404 before synthesis, 200 after save", async () => {
  assert.equal((await authed("/profile")).status, 404);
  store.saveProfile({ headline: "h", sections: [], generated_at: "2026-06-11T00:00:00Z", model: "test" });
  assert.equal((await authed("/profile")).status, 200);
});

test("POST /events without id gets one assigned, and signal batches rebuild views", async () => {
  const r = await postJson("/events", {
    type: "signal.topic",
    source: "mcp:claude-code",
    payload: {
      topic: "sqlite", weight: 0.5, intent: "building", sentiment: "neutral",
      depth: "moderate", category: "technology", entities: [],
    },
    provenance: { kind: "mcp", client: "claude-code" },
  });
  assert.equal(r.status, 201);
  const body = await r.json() as { inserted: number; ids: string[] };
  assert.equal(body.inserted, 1);
  assert.match(body.ids[0] ?? "", /^[0-9a-f-]{36}$/);
  const topics = await (await authed("/topics")).json() as Array<{ topic_key: string }>;
  assert.ok(topics.some((t) => t.topic_key === "sqlite"), "rebuild must run for signal events");
});

test("requests with a foreign Origin are rejected", async () => {
  const r = await postJson("/events", { type: "signal.topic" }, { Origin: "https://evil.example" });
  assert.equal(r.status, 403);
  const ok = await postJson("/events", { type: "signal.bogus" }, { Origin: BASE });
  assert.equal(ok.status, 400); // same-origin passes the guard, fails validation as usual
});

test("requests with a foreign Host are rejected (DNS rebinding)", async () => {
  // fetch() forbids overriding Host — use a raw request.
  const status = await new Promise<number>((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: PORT, path: "/stats", headers: { Host: "evil.example" } },
      (res) => resolve(res.statusCode ?? 0),
    );
    req.on("error", reject);
    req.end();
  });
  assert.equal(status, 403);
});

test("POST /events without JSON content type is rejected (CSRF preflight bypass)", async () => {
  const r = await authed("/events", {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify({ type: "signal.topic" }),
  });
  assert.equal(r.status, 415);
});

test("GET /engine reports engine status shape", async () => {
  const e = await (await authed("/engine")).json() as {
    hasKey: boolean; ollama: { reachable: boolean; models: string[] }; recommended: string; pull: { state: string };
  };
  assert.equal(typeof e.hasKey, "boolean");
  assert.equal(typeof e.ollama.reachable, "boolean");
  assert.ok(Array.isArray(e.ollama.models));
  assert.equal(typeof e.recommended, "string");
  assert.equal(e.pull.state, "idle");
});

test("POST /engine/key rejects non-Anthropic keys, accepts + masks a valid one, applies it live", async () => {
  assert.equal((await postJson("/engine/key", { key: "nope" })).status, 400);
  const r = await postJson("/engine/key", { key: "sk-ant-test0123456789abcdef" });
  assert.equal(r.status, 200);
  const body = await r.json() as { ok: boolean; keyMasked: string };
  assert.equal(body.ok, true);
  assert.ok(body.keyMasked.startsWith("sk-ant-test0") && body.keyMasked.endsWith("cdef") && body.keyMasked.includes("…"));
  const e = await (await authed("/engine")).json() as { hasKey: boolean }; // applied live, no restart
  assert.equal(e.hasKey, true);
});

test("POST /engine/key without JSON content type is rejected", async () => {
  const r = await authed("/engine/key", {
    method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify({ key: "sk-ant-x" }),
  });
  assert.equal(r.status, 415);
});

test("POST /events accepts context.read and keeps it out of /topics", async () => {
  const before = await (await authed("/topics")).json() as Array<{ topic_key: string }>;
  const r = await postJson("/events", {
    type: "context.read",
    source: "mcp:cursor",
    payload: { scope: "brief", client_purpose: "personalize review", items: 4 },
    provenance: { kind: "mcp", client: "cursor" },
  });
  assert.equal(r.status, 201);
  const after = await (await authed("/topics")).json() as Array<{ topic_key: string }>;
  assert.deepEqual(after.map((t) => t.topic_key), before.map((t) => t.topic_key));
});

test("DELETE /events requires explicit confirmation, then wipes", async () => {
  assert.equal((await authed("/events", { method: "DELETE" })).status, 400);
  const r = await authed("/events?confirm=all", { method: "DELETE" });
  assert.equal(r.status, 200);
  const stats = await (await authed("/stats")).json() as { total: number };
  assert.equal(stats.total, 0);
  // Restore the fixture for the remaining tests.
  store.append([topicEvent]);
  store.rebuild();
});

test("DELETE /topics/:topic hard-deletes and rebuilds", async () => {
  const r = await authed("/topics/" + encodeURIComponent("rust"), { method: "DELETE" });
  const body = await r.json() as { deleted: number };
  assert.equal(body.deleted, 1);
  const topics = await (await authed("/topics")).json() as unknown[];
  assert.equal(topics.length, 0);
});

test("POST /scopes sets a client allowlist and GET /scopes reflects it", async () => {
  const r = await postJson("/scopes", { client: "cursor", categories: ["technology", "career"] });
  assert.equal(r.status, 200);
  const scopes = await (await authed("/scopes")).json() as Record<string, string[]>;
  assert.deepEqual(scopes.cursor, ["technology", "career"]);
});

test("POST /scopes with [] revokes (client reads nothing) — enforced on /profile", async () => {
  await postJson("/scopes", { client: "cursor", categories: [] });
  // Enforcement follows the client's own token: the owner always reads unscoped.
  const r = await fetch(BASE + "/profile", { headers: { authorization: `Bearer ${cursorToken}` } });
  assert.equal(r.status, 403, "a revoked client is scoped-out of the profile");
});

test("POST /scopes validates: unknown category 400, missing client 400, non-JSON 415", async () => {
  assert.equal((await postJson("/scopes", { client: "cursor", categories: ["bogus"] })).status, 400);
  assert.equal((await postJson("/scopes", { categories: ["technology"] })).status, 400);
  assert.equal((await postJson("/scopes", { client: "cursor", categories: "technology" })).status, 400);
  const r = await authed("/scopes", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" });
  assert.equal(r.status, 415);
});

test("DELETE /scopes/:client clears the scope (restores full access)", async () => {
  await postJson("/scopes", { client: "cursor", categories: ["technology"] });
  const r = await authed("/scopes/cursor", { method: "DELETE" });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { cleared: true });
  const scopes = await (await authed("/scopes")).json() as Record<string, string[]>;
  assert.equal(scopes.cursor, undefined);
  // Cleared → unrestricted again: /profile no longer scoped-out (404 = none synthesized, not 403).
  const r2 = await fetch(BASE + "/profile", { headers: { authorization: `Bearer ${cursorToken}` } });
  assert.equal(r2.status, 404);
});
