/**
 * Local HTTP API + dashboard — loopback only, the single access path to the event store.
 * Phase 2's MCP context server will be a client of this API.
 */

import http from "node:http";
import { readFileSync } from "node:fs";
import { askUserModel } from "./ask.js";
import { loadConfig, saveConfig } from "./config.js";
import { runConsolidation, shouldRunNow } from "./consolidate.js";
import { allowedCategories, loadScopes, type Category } from "./permissions.js";
import { newEvent, validateEvent, type EventType, type PersnallyEvent, type Provenance } from "./events.js";
import { importNewClaudeCodeSessions } from "./importers/claude-code.js";
import { chooseExtractor, ollamaTags, pullOllamaModel, RECOMMENDED_LOCAL_MODEL } from "./llm.js";
import { synthesizeProfile } from "./profile.js";
import { refreshVoice } from "./voice.js";
import type { EventStore } from "./store.js";

export const DEFAULT_PORT = 4983;
const MAX_BODY_BYTES = 25 * 1024 * 1024; // generous for import batches; bounds memory
const MAX_QUERY_LIMIT = 10_000;          // ceiling for public ?limit= params

// Single source of truth for the user-visible version: package.json.
const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf-8")) as { version: string };
export const VERSION: string = pkg.version;

// In-flight local-model download — module state so progress survives across poll requests.
type PullState = { state: "idle" | "pulling" | "done" | "error"; model: string; percent: number; status: string; error: string };
let pull: PullState = { state: "idle", model: "", percent: 0, status: "", error: "" };

// /ask spends inference per call — bound what a looping agent can burn.
// Sliding window, in-memory: resets on daemon restart, which is fine for a
// budget guard (this is cost control, not security).
const ASK_LIMIT = 20;
const ASK_WINDOW_MS = 10 * 60 * 1000;
const askTimes: number[] = [];
function askAllowed(now: number): boolean {
  while (askTimes.length && now - askTimes[0]! > ASK_WINDOW_MS) askTimes.shift();
  if (askTimes.length >= ASK_LIMIT) return false;
  askTimes.push(now);
  return true;
}

export function startDaemon(store: EventStore, port = DEFAULT_PORT): http.Server {
  const localHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  const server = http.createServer(async (req, res) => {
    // Loopback binding alone doesn't stop browsers: webpages can fire
    // no-preflight POSTs at 127.0.0.1 (CSRF) or reach it via DNS rebinding.
    if (!localHosts.includes(req.headers.host ?? "")) {
      return json(res, 403, { error: "forbidden: unrecognized Host" });
    }
    const origin = req.headers.origin;
    if (origin && !localHosts.some((h) => origin === `http://${h}`)) {
      return json(res, 403, { error: "forbidden: cross-origin requests are not allowed" });
    }
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    try {
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(dashboardHtml());
      }
      if (req.method === "GET" && url.pathname === "/health") {
        return json(res, 200, { ok: true, version: VERSION });
      }
      if (req.method === "GET" && url.pathname === "/stats") {
        return json(res, 200, store.stats());
      }
      if (req.method === "GET" && url.pathname === "/activity") {
        return json(res, 200, store.activity());
      }
      if (req.method === "GET" && url.pathname === "/topics") {
        const client = url.searchParams.get("client");
        const allowed = client ? allowedCategories(client) : null;
        let topics = store.topics(num(url, "limit", 50));
        if (allowed) topics = topics.filter((t) => allowed.includes(t.category as Category));
        return json(res, 200, topics);
      }
      if (req.method === "GET" && url.pathname === "/profile") {
        // The synthesized profile is holistic prose — a scoped client gets only its
        // allowed topics (above), never the cross-category narrative.
        const client = url.searchParams.get("client");
        if (client && allowedCategories(client) !== null) {
          return json(res, 403, { error: "scoped: this client does not have profile access", scoped: true });
        }
        const profile = store.getProfile();
        return profile ? json(res, 200, profile) : json(res, 404, { error: "no profile synthesized yet" });
      }
      if (req.method === "GET" && url.pathname === "/voice") {
        // Stylistic, not topical — served to every client (it's how you write, not what about).
        return json(res, 200, store.voice());
      }
      if (req.method === "DELETE" && url.pathname.startsWith("/voice/")) {
        const [, , dimension, pattern] = url.pathname.split("/");
        if (!dimension || !pattern) return json(res, 400, { error: "dimension and pattern required" });
        return json(res, 200, { deleted: store.forgetStyle(dimension, decodeURIComponent(pattern)) });
      }
      if (req.method === "GET" && url.pathname === "/scopes") {
        return json(res, 200, loadScopes());
      }
      if (req.method === "POST" && url.pathname === "/synthesize") {
        const engine = await chooseExtractor("profile");
        const profile = await synthesizeProfile(store, engine.extract, engine.model);
        safeRefreshVoice(store, "dashboard"); // keep "how you write" current with the portrait
        return json(res, 200, profile);
      }
      if (req.method === "POST" && url.pathname === "/consolidate") {
        const engine = await chooseExtractor("extract").catch(() => null);
        const result = await runConsolidation(store, engine);
        safeRefreshVoice(store, "dashboard");
        return json(res, 200, result);
      }
      // Engine onboarding: status + live key-save + one-click local-model pull.
      if (req.method === "GET" && url.pathname === "/engine") {
        const tags = await ollamaTags();
        const cfgKey = loadConfig().anthropic_api_key;
        const key = process.env.ANTHROPIC_API_KEY || (typeof cfgKey === "string" ? cfgKey : "");
        return json(res, 200, {
          hasKey: key.startsWith("sk-ant-"),
          keyMasked: key ? `${key.slice(0, 12)}…${key.slice(-4)}` : "",
          hasProfile: !!store.getProfile(),
          ollama: { reachable: tags !== null, models: tags ?? [], hasModel: (tags?.length ?? 0) > 0 },
          recommended: RECOMMENDED_LOCAL_MODEL,
          pull,
        });
      }
      if (req.method === "POST" && url.pathname === "/engine/key") {
        if (!(req.headers["content-type"] ?? "").includes("application/json")) {
          return json(res, 415, { error: "Content-Type must be application/json" });
        }
        const body = (await readBody(req)) as { key?: unknown };
        const key = typeof body.key === "string" ? body.key.trim() : "";
        if (!key.startsWith("sk-ant-")) return json(res, 400, { error: "expected an Anthropic key (sk-ant-…)" });
        saveConfig({ anthropic_api_key: key });
        process.env.ANTHROPIC_API_KEY = key; // apply to the running daemon — no restart needed
        return json(res, 200, { ok: true, keyMasked: `${key.slice(0, 12)}…${key.slice(-4)}` });
      }
      if (req.method === "POST" && url.pathname === "/engine/pull") {
        if (!(req.headers["content-type"] ?? "").includes("application/json")) {
          return json(res, 415, { error: "Content-Type must be application/json" });
        }
        if (pull.state === "pulling") return json(res, 200, { started: false, ...pull });
        const body = (await readBody(req).catch(() => ({}))) as { model?: unknown };
        const model = typeof body.model === "string" && body.model ? body.model : RECOMMENDED_LOCAL_MODEL;
        if ((await ollamaTags()) === null) {
          return json(res, 400, { error: "Ollama isn't running. Install it from ollama.com, then try again." });
        }
        pull = { state: "pulling", model, percent: 0, status: "starting", error: "" };
        pullOllamaModel(model, (p) => { pull.percent = p.percent; pull.status = p.status; })
          .then(() => { pull = { ...pull, state: "done", percent: 100, status: "ready" }; })
          .catch((e) => { pull = { ...pull, state: "error", error: e instanceof Error ? e.message : String(e) }; });
        return json(res, 200, { started: true, model });
      }
      if (req.method === "GET" && url.pathname === "/engine/pull") {
        return json(res, 200, pull);
      }
      // The ask_user_model loop: agents ask about the user; the model answers
      // with confidence or defers. Validation happens before engine selection
      // so bad requests never spend inference.
      if (req.method === "POST" && url.pathname === "/ask") {
        if (!(req.headers["content-type"] ?? "").includes("application/json")) {
          return json(res, 415, { error: "Content-Type must be application/json" });
        }
        const body = (await readBody(req)) as { question?: unknown; client?: unknown; asker?: unknown };
        const question = typeof body.question === "string" ? body.question.trim() : "";
        if (!question || question.length > 500) {
          return json(res, 400, { error: "question required (1–500 chars)" });
        }
        const client = typeof body.client === "string" && body.client
          ? body.client.toLowerCase().replace(/[^a-z0-9._-]/g, "-")
          : null;
        const asker = typeof body.asker === "string" && body.asker ? body.asker : (client ?? "dashboard");
        if (!askAllowed(Date.now())) {
          return json(res, 429, { error: `ask limit reached (${ASK_LIMIT} per ${ASK_WINDOW_MS / 60000} min) — protects your inference budget from a looping agent` });
        }
        const engine = await chooseExtractor("extract").catch(() => null);
        const result = await askUserModel(store, {
          question,
          asker,
          source: client ? `mcp:${client}` : "dashboard",
          provenance: client ? { kind: "mcp", client } : { kind: "local", surface: "dashboard" },
          allowed: client ? allowedCategories(client) : null,
        }, engine);
        return json(res, 200, result);
      }
      if (req.method === "GET" && url.pathname === "/questions") {
        return json(res, 200, store.askHistory(num(url, "limit", 50)));
      }
      // The feedback half of the loop: the user labels an answer right/wrong
      // on the dashboard — the labeled examples the behavior model learns from.
      if (req.method === "POST" && url.pathname === "/feedback") {
        if (!(req.headers["content-type"] ?? "").includes("application/json")) {
          return json(res, 415, { error: "Content-Type must be application/json" });
        }
        const body = (await readBody(req)) as { answer_id?: unknown; verdict?: unknown };
        const verdict = body.verdict;
        if (verdict !== "approved" && verdict !== "edited" && verdict !== "vetoed") {
          return json(res, 400, { error: "verdict must be approved | edited | vetoed" });
        }
        const answerId = typeof body.answer_id === "string" ? body.answer_id : "";
        const subject = store.getEvents([answerId])[0];
        if (!subject || subject.type !== "agent.answer") {
          return json(res, 404, { error: "no such answer" });
        }
        const event = newEvent("feedback.signal", "dashboard",
          { subject_id: answerId, verdict },
          { kind: "local", surface: "dashboard" });
        store.append([event]);
        return json(res, 201, { ok: true, id: event.id });
      }
      if (req.method === "GET" && url.pathname === "/events") {
        const ids = url.searchParams.get("ids");
        if (ids) return json(res, 200, store.getEvents(ids.split(",").filter(Boolean)));
        return json(res, 200, store.query({
          type: url.searchParams.get("type") ?? undefined,
          source: url.searchParams.get("source") ?? undefined,
          since: url.searchParams.get("since") ?? undefined,
          limit: num(url, "limit", 100),
        }));
      }
      if (req.method === "POST" && url.pathname === "/events") {
        // JSON-only forces browsers to preflight (which fails above) — no-preflight
        // content types like text/plain can't reach the write path.
        if (!(req.headers["content-type"] ?? "").includes("application/json")) {
          return json(res, 415, { error: "Content-Type must be application/json" });
        }
        const body = await readBody(req);
        // The daemon owns event identity: items without an id get one assigned here.
        const events: PersnallyEvent[] = (Array.isArray(body) ? body : [body]).map((raw) => {
          const r = raw as Record<string, unknown>;
          return r.id
            ? validateEvent(r)
            : newEvent(
                r.type as EventType,
                String(r.source ?? ""),
                r.payload as Record<string, unknown>,
                r.provenance as Provenance,
                typeof r.ts === "string" ? r.ts : undefined,
              );
        });
        store.append(events);
        // Views derive only from signal.* events — skip the O(all-events) rebuild
        // for telemetry writes like context.read.
        if (events.some((e) => e.type.startsWith("signal."))) store.rebuild();
        return json(res, 201, { inserted: events.length, ids: events.map((e) => e.id) });
      }
      if (req.method === "DELETE" && url.pathname === "/events") {
        if (url.searchParams.get("confirm") !== "all") {
          return json(res, 400, { error: "destructive: requires ?confirm=all" });
        }
        store.forgetAll();
        return json(res, 200, { deleted: "all" });
      }
      if (req.method === "DELETE" && url.pathname.startsWith("/topics/")) {
        const topic = decodeURIComponent(url.pathname.slice("/topics/".length));
        if (!topic) return json(res, 400, { error: "topic required" });
        return json(res, 200, { deleted: store.forgetTopic(topic) });
      }
      return json(res, 404, { error: "not found" });
    } catch (e) {
      return json(res, 400, { error: e instanceof Error ? e.message : "bad request" });
    }
  });
  server.listen(port, "127.0.0.1");

  // Every 30 min: pick up new Claude Code chats, then run the once-a-day reflection.
  const timer = setInterval(async () => {
    await autoImportNewSessions(store);
    const lastRun = loadConfig().last_consolidation;
    if (!shouldRunNow(typeof lastRun === "string" ? lastRun : undefined, new Date())) return;
    try {
      const engine = await chooseExtractor("extract").catch(() => null);
      const r = await runConsolidation(store, engine);
      safeRefreshVoice(store, "cli"); // nightly: keep the voice fingerprint fresh + clean
      console.error(`consolidation: ${r.newSignals} new signals, ${r.assertions} assertions, profile ${r.profileRefreshed ? "refreshed" : "kept"}, ${r.stylePruned} style signals pruned`);
    } catch (e) {
      console.error("consolidation failed:", e instanceof Error ? e.message : e);
    }
  }, 30 * 60 * 1000);
  timer.unref();
  server.on("close", () => clearInterval(timer));

  return server;
}

/**
 * Ingest Claude Code sessions created since the last pass — the daemon's
 * automatic capture of new chats (no user action, no per-session hook). A
 * key-less, Ollama-less machine has no extractor: skip rather than block.
 * Never throws — capture must not take the daemon down.
 */
export async function autoImportNewSessions(store: EventStore): Promise<void> {
  try {
    const engine = await chooseExtractor("extract").catch(() => null);
    if (!engine) return;
    const r = await importNewClaudeCodeSessions(store, engine.extract, engine.model);
    if (r.events) {
      store.rebuild();
      console.error(`auto-import: ${r.newSessions} new Claude Code session(s) → ${r.events} events`);
    }
  } catch (e) {
    console.error("auto-import failed:", e instanceof Error ? e.message : e);
  }
}

let cachedHtml: string | undefined;
function dashboardHtml(): string {
  cachedHtml ??= readFileSync(new URL("./dashboard.html", import.meta.url), "utf-8");
  return cachedHtml;
}

// Re-derive the voice fingerprint alongside synthesize/reflect so "how you write"
// stays current and clean. Deterministic + offline; must never break the caller.
function safeRefreshVoice(store: EventStore, surface: "cli" | "dashboard"): void {
  try {
    refreshVoice(store, undefined, surface);
  } catch (e) {
    console.error("voice refresh failed:", e instanceof Error ? e.message : e);
  }
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  // Never throw from the responder — the request socket may already be gone
  // (e.g. an oversized body we destroyed), and a throw here would be unhandled.
  if (res.headersSent || res.writableEnded) return;
  try {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  } catch { /* socket closed mid-response */ }
}

function num(url: URL, key: string, fallback: number): number {
  const v = Number(url.searchParams.get(key));
  return Number.isFinite(v) && v > 0 ? Math.min(v, MAX_QUERY_LIMIT) : fallback;
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on("end", () => {
      try { resolve(JSON.parse(data)); } catch { reject(new Error("invalid JSON body")); }
    });
    req.on("error", reject);
  });
}
