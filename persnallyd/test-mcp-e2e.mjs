#!/usr/bin/env node
// Protocol e2e: spawns the MCP server against a mock daemon and verifies every
// tool round-trips correctly. HOME is sandboxed so telemetry/migration stay isolated.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MOCK_PORT = 49832;
const received = { posts: [], postAuths: [], deletes: [], asks: [], reads: [], readAuths: [], contextGets: [] };

const mockDaemon = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const respond = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.method === "POST" && req.url === "/events") {
      received.posts.push(JSON.parse(body));
      received.postAuths.push(req.headers.authorization ?? null);
      return respond(201, { inserted: JSON.parse(body).length ?? 1, ids: ["x"] });
    }
    if (req.method === "POST" && req.url === "/reads") {
      received.reads.push(JSON.parse(body));
      received.readAuths.push(req.headers.authorization ?? null);
      return respond(202, { recorded: true });
    }
    if (req.method === "POST" && req.url === "/ask") {
      received.asks.push(JSON.parse(body));
      return respond(200, {
        question_id: "q1", answer_id: "a1", deferred: false, confidence: 0.88,
        answer: "Yes — they always want tests with refactors.", evidence_event_ids: ["e1", "e2"],
      });
    }
    if (req.method === "DELETE") {
      received.deletes.push(req.url);
      return respond(200, { deleted: 1 });
    }
    const path = (req.url ?? "").split("?")[0];
    // The one serving path: the daemon renders and records together, so the
    // tool no longer assembles context or POSTs its own read event.
    if (path === "/context") {
      received.contextGets.push(req.url);
      const detail = new URL(req.url, "http://x").searchParams.get("detail") ?? "brief";
      return respond(200, {
        text: [
          "# About the user", "A builder", "",
          "# Current interests (decay-weighted)",
          "- rust (technology, building, weight 0.90)", "",
          "# How to write for this user", "Write like this user: terse, no filler.",
        ].join("\n"),
        items: detail === "full" ? 4 : 3,
      });
    }
    if (path === "/profile") return respond(200, { headline: "A builder", sections: [{ title: "Work", body: "Ships fast." }], generated_at: "2026-06-11" });
    if (path === "/topics") return respond(200, [{ topic: "rust", category: "technology", weight: 0.9, signals: 3, dominant_intent: "building", sentiment_balance: 0.5, entities: [] }]);
    if (path === "/stats") return respond(200, { total: 4, first: "2026-01-01", last: "2026-06-11" });
    if (path === "/voice") return respond(200, { pack: "Write like this user: terse, no filler.", items: [{ dimension: "voice", pattern: "terse, no filler", polarity: "does", confidence: 0.8, evidence: "x", basis: "stylometry" }] });
    if (path === "/search") {
      const q = new URL(req.url, "http://x").searchParams.get("q");
      return respond(200, q === "rust"
        ? [{ kind: "topic", text: "rust", detail: "technology · building · weight 0.90 · 3 signal(s)", score: 4, event_ids: ["e1"] }]
        : []);
    }
    respond(404, { error: "not found" });
  });
});

// Fake HOME with a v1 graph so migration is exercised too.
const home = mkdtempSync(join(tmpdir(), "persnally-e2e-"));
mkdirSync(join(home, ".persnally"), { recursive: true });
writeFileSync(join(home, ".persnally", "interest-graph.json"), JSON.stringify({
  nodes: {
    reactjs: {
      topic: "ReactJS", category: "technology", current_weight: 0.7, avg_depth: 0.9,
      dominant_intent: "building", sentiment_balance: 0.3, last_seen: "2026-06-01T00:00:00Z", entities: ["Next.js"],
    },
  },
}));

await new Promise((r) => mockDaemon.listen(MOCK_PORT, "127.0.0.1", r));

function wire(proc) {
  let nextId = 0;
  const pending = new Map();
  proc.stdout.on("data", (d) => {
    for (const line of d.toString().split("\n").filter(Boolean)) {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  const rpc = (method, params) => {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      pending.set(id, resolve);
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      setTimeout(() => reject(new Error(`timeout: ${method}`)), 8000);
    });
  };
  const callTool = async (name, args) => {
    const r = await rpc("tools/call", { name, arguments: args });
    return r.result.content[0].text;
  };
  return { rpc, callTool };
}

const srv = spawn("node", ["build/src/mcp/index.js"], {
  env: { ...process.env, HOME: home, PERSNALLYD_URL: `http://127.0.0.1:${MOCK_PORT}` },
  stdio: ["pipe", "pipe", "inherit"],
});
const { rpc, callTool } = wire(srv);

// ── handshake ──
const init = await rpc("initialize", {
  protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e-test", version: "0" },
});
assert.equal(init.result.serverInfo.name, "persnally");
srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

// ── tools list ──
const tools = (await rpc("tools/list", {})).result.tools.map((t) => t.name).sort();
assert.deepEqual(tools, ["persnally_ask", "persnally_context", "persnally_forget", "persnally_interests", "persnally_search", "persnally_track"]);
console.log("✅ handshake + tool list");

// ── track → daemon POST with provenance ──
const trackText = await callTool("persnally_track", {
  topics: [{ topic: "event sourcing", weight: 0.9, intent: "building", sentiment: "positive", depth: "deep", category: "technology", entities: ["SQLite"] }],
});
assert.match(trackText, /Recorded.*1 topic/);
const tracked = received.posts.find((p) => Array.isArray(p) && p[0]?.payload?.topic === "event sourcing");
assert.ok(tracked, "track must POST to the daemon");
assert.equal(tracked[0].source, "mcp:e2e-test");
assert.deepEqual(tracked[0].provenance, { kind: "mcp", client: "e2e-test" });
console.log("✅ track → POST /events with client provenance");

// ── track live style signals → signal.style with basis "observed" (Slice 2) ──
const styleText = await callTool("persnally_track", {
  style: [{ dimension: "convention", pattern: "prefers pnpm over npm", polarity: "prefers", confidence: 0.8, evidence: "said so twice" }],
});
assert.match(styleText, /1 style signal/);
const styled = received.posts.find((p) => Array.isArray(p) && p[0]?.type === "signal.style");
assert.ok(styled, "style capture must POST a signal.style event");
assert.equal(styled[0].payload.basis, "observed", "live capture marks basis=observed");
assert.equal(styled[0].payload.pattern, "prefers pnpm over npm");
assert.deepEqual(styled[0].provenance, { kind: "mcp", client: "e2e-test" });
console.log("✅ track captures live style signals (basis observed)");

// ── track corrections → user.correction with action contradict ──
const corrText = await callTool("persnally_track", {
  corrections: [{ subject: "npm", correction: "uses pnpm, not npm" }],
});
assert.match(corrText, /1 correction\(s\) — now authoritative/);
const corrected = received.posts.find((p) => Array.isArray(p) && p[0]?.type === "user.correction");
assert.ok(corrected, "corrections must POST a user.correction event");
assert.deepEqual(corrected[0].payload, { target_id: "npm", action: "contradict", reason: "uses pnpm, not npm" });
assert.deepEqual(corrected[0].provenance, { kind: "mcp", client: "e2e-test" });
console.log("✅ track records corrections as authoritative user.correction events");

// ── migration fired on initialize ──
const migrated = received.posts.find((p) => Array.isArray(p) && p[0]?.provenance?.file === "interest-graph.json");
assert.ok(migrated, "v1 graph must be migrated");
assert.equal(migrated[0].payload.topic, "ReactJS");
assert.equal(migrated[0].payload.depth, "deep");
assert.ok(existsSync(join(home, ".persnally", "interest-graph.json.v1-migrated")), "v1 file renamed");
console.log("✅ v1 graph migrated and renamed");

// ── context read ──
const ctx = await callTool("persnally_context", { detail: "brief" });
assert.match(ctx, /A builder/);
assert.match(ctx, /rust.*0\.90/);
assert.match(ctx, /How to write for this user[\s\S]*terse, no filler/, "context injects the voice pack");
console.log("✅ context renders profile + voice + topics");

// ── the serving path: this process asks the daemon, and never assembles or
// attributes context itself. Recording is the daemon's job (it holds the
// verified token), and is covered by test/context-read.test.ts.
assert.equal(received.contextGets.length, 1, "context must be served through GET /context");
{
  const q = new URL(received.contextGets[0], "http://x").searchParams;
  assert.equal(q.get("detail"), "brief");
  assert.equal(q.get("client"), "e2e-test", "the daemon needs the client to scope and attribute");
}
await callTool("persnally_context", { detail: "full", purpose: "personalize a code review" });
{
  const q = new URL(received.contextGets[1], "http://x").searchParams;
  assert.equal(q.get("detail"), "full");
  assert.equal(q.get("purpose"), "personalize a code review", "purpose reaches the receipt");
}
// A read this process cannot avoid mis-declaring: it does not declare one.
assert.equal(
  received.posts.filter((p) => Array.isArray(p) && p.some((e) => e?.type === "context.read")).length,
  0,
  "the MCP server must not construct context.read events",
);
console.log("✅ context served through the one path, with client + purpose passed through");

// ── ask → POST /ask with client identity; answer carries confidence + evidence count ──
const askText = await callTool("persnally_ask", { question: "Would they want tests with this refactor?" });
assert.match(askText, /Yes — they always want tests/);
assert.match(askText, /confidence 0\.88/);
assert.match(askText, /2 evidence event\(s\)/);
assert.equal(received.asks.length, 1, "ask must POST to the daemon");
assert.equal(received.asks[0].question, "Would they want tests with this refactor?");
assert.equal(received.asks[0].client, "e2e-test", "the daemon needs the client for scoping + provenance");
// The richest disclosure path of all — profile, assertions, corrections, voice
// — recorded nothing, so it was invisible in both the receipts feed and the
// north-star metric it is supposed to drive.
const askReads = () => received.reads.filter((r) => r.scope === "ask");
assert.equal(askReads().length, 1, "an ask must declare a read — the richest disclosure of all");
assert.match(askReads()[0].purpose, /^asked: Would they want tests/);
console.log("✅ ask → daemon /ask with client identity, recorded as a read");

// ── search → GET /search; hits recorded as a context.read, misses not ──
const searchHit = await callTool("persnally_search", { query: "rust" });
assert.match(searchHit, /What Persnally knows about "rust"/);
assert.match(searchHit, /\[interest\] rust/);
const searchReads = () => received.reads.filter((r) => r.scope === "search");
assert.equal(searchReads().length, 1, "a search that serves hits declares a read");
assert.equal(searchReads()[0].purpose, "looked up: rust");
const searchMiss = await callTool("persnally_search", { query: "cobol" });
assert.match(searchMiss, /nothing on "cobol"/);
assert.equal(searchReads().length, 1, "empty searches don't inflate the read metric");
console.log("✅ search → targeted lookup with read recording");

// ── interests + forget ──
assert.match(await callTool("persnally_interests", {}), /rust — 0\.90/);
const interestReads = () => received.reads.filter((r) => r.scope === "interests");
assert.equal(interestReads().length, 1, "showing the user their own profile is still a disclosure");
await callTool("persnally_forget", { topic: "rust" });
assert.ok(received.deletes.some((u) => u === "/topics/rust"), "forget must DELETE /topics/:t");
console.log("✅ interests + forget");

// ── forget a style pattern ──
const forgetStyleText = await callTool("persnally_forget", { style: { dimension: "emphasis", pattern: "be 100% sure" } });
assert.match(forgetStyleText, /Forgot "be 100% sure"/);
assert.ok(received.deletes.some((u) => u === "/voice/emphasis/be%20100%25%20sure"), "forget must DELETE /voice/:dimension/:pattern");
console.log("✅ forget a style pattern");

// ── connect-issued identity: env pin beats the handshake name, bearer rides every request ──
const srv2 = spawn("node", ["build/src/mcp/index.js"], {
  env: {
    ...process.env, HOME: home, PERSNALLYD_URL: `http://127.0.0.1:${MOCK_PORT}`,
    PERSNALLY_CLIENT: "cursor", PERSNALLY_CLIENT_TOKEN: "tok-e2e",
  },
  stdio: ["pipe", "pipe", "inherit"],
});
const w2 = wire(srv2);
await w2.rpc("initialize", {
  protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "lying-client", version: "0" },
});
srv2.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
await w2.callTool("persnally_track", {
  topics: [{ topic: "auth", weight: 0.5, intent: "building", sentiment: "neutral", depth: "moderate", category: "technology", entities: [] }],
});
const pinnedIdx = received.posts.findIndex((p) => Array.isArray(p) && p[0]?.payload?.topic === "auth");
assert.ok(pinnedIdx >= 0, "pinned-identity track must POST");
assert.equal(received.posts[pinnedIdx][0].source, "mcp:cursor", "identity comes from the connect env, not the handshake name");
assert.deepEqual(received.posts[pinnedIdx][0].provenance, { kind: "mcp", client: "cursor" });
assert.equal(received.postAuths[pinnedIdx], "Bearer tok-e2e", "the connect-issued token authenticates the write");
assert.ok(received.postAuths.slice(0, pinnedIdx).every((a) => a === null), "the un-connected instance sent no token");
srv2.kill();
console.log("✅ env-pinned identity + bearer token on the wire");

srv.kill();
mockDaemon.close();
rmSync(home, { recursive: true, force: true });
console.log("\n=== ALL E2E CHECKS PASSED ===");
process.exit(0);
