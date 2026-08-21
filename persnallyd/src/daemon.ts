/**
 * Local HTTP API + dashboard — loopback only, the single access path to the event store.
 * Phase 2's MCP context server will be a client of this API.
 */

import http from "node:http";
import { readFileSync } from "node:fs";
import { askUserModel } from "./ask.js";
import { loadConfig, saveConfig } from "./config.js";
import { runConsolidation, shouldRunNow } from "./consolidate.js";
import {
  allowedCategories, CATEGORIES, clearScope, clientForToken, createSession, dashboardKey,
  hasToken, isRevoked, loadScopes, SESSION_COOKIE, SESSION_TTL_SECONDS, sessionNeedsRefresh, sessionValid, setScope,
  verifyDashboardKey, type Category,
} from "./permissions.js";
import { newEvent, validateEvent, type EventType, type PersnallyEvent, type Provenance } from "./events.js";
import { importNewClaudeCodeSessions } from "./importers/claude-code.js";
import { chooseExtractor, resolvedModels, ollamaTags, pullOllamaModel, RECOMMENDED_LOCAL_MODEL } from "./llm.js";
import { refreshScopedProfiles, scopeKey, synthesizeProfile } from "./profile.js";
import { searchContext } from "./search.js";
import { importAllSources } from "./setup.js";
import { refreshVoice } from "./voice.js";
import type { EventStore } from "./store.js";
import { engineFailure, recordEngineFailure, recordEngineSuccess } from "./engine-health.js";

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

/**
 * Who is calling. Every route except /health and the dashboard bootstrap needs
 * one of these two identities — loopback binding is not a credential, since the
 * port is reachable by every process and every user on the machine.
 *
 * `owner`  — the user's own surface: a browser session minted from the
 *            mode-0600 dashboard key, or that key presented as a bearer.
 * `client` — a connected AI client, identified by the token issued at connect.
 */
type Auth =
  | { kind: "owner" }
  | { kind: "client"; client: string }
  | { kind: "none"; error: string };

const NEEDS_AUTH =
  "authentication required — open the dashboard with `persnally dashboard`, or connect an AI client with `persnally connect <client>`";

function authenticate(req: http.IncomingMessage, claimed: string | null): Auth {
  const session = cookie(req, SESSION_COOKIE);
  if (session && sessionValid(session)) return { kind: "owner" };

  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (token) {
    const client = clientForToken(token);
    if (client) return { kind: "client", client };
    // The dashboard key doubles as a bearer so local scripts and curl can use it.
    if (verifyDashboardKey(token)) return { kind: "owner" };
    return { kind: "none", error: "unrecognized token — reconnect with: persnally connect <client>, then restart the client" };
  }
  if (claimed && hasToken(claimed)) {
    return { kind: "none", error: `client '${claimed}' has an identity token and must present it — re-run: persnally connect ${claimed}, then restart the client` };
  }
  return { kind: "none", error: NEEDS_AUTH };
}

/**
 * Routes a connected AI client legitimately needs. Everything else is the
 * owner's own surface, so a client token cannot read the raw event log via
 * /events, widen its own grant via /scopes, or spend inference on /synthesize.
 */
function clientMayReach(method: string, path: string): boolean {
  switch (method) {
    case "GET":
      return path === "/topics" || path === "/profile" || path === "/voice"
        || path === "/search" || path === "/stats" || path === "/skills";
    case "POST":
      return path === "/events" || path === "/ask";
    case "DELETE":
      return path === "/events" || path.startsWith("/topics/") || path.startsWith("/voice/");
    default:
      return false;
  }
}

/**
 * The scope a request reads under. It comes from the verified token, never from
 * a self-reported `?client=` — but a name claimed alongside a token still has
 * to match it, so a client can't act under another's identity. The owner reads
 * unscoped.
 */
function scopeFor(auth: Auth, claimed: string | null): { client: string | null; error?: string } {
  if (auth.kind !== "client") return { client: null };
  if (claimed && claimed !== auth.client) {
    return { client: null, error: `token identifies '${auth.client}' but the request claims '${claimed}'` };
  }
  return { client: auth.client };
}

function cookie(req: http.IncomingMessage, name: string): string {
  const raw = req.headers.cookie;
  if (!raw) return "";
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return "";
}

export function startDaemon(store: EventStore, port = DEFAULT_PORT): http.Server {
  dashboardKey(); // mint on first run so `persnally dashboard` always has a link to print
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
      // Liveness only (no store data) — lifecycle probes it before any
      // credential exists, so it stays open.
      if (req.method === "GET" && url.pathname === "/health") {
        return json(res, 200, { ok: true, version: VERSION });
      }
      if (req.method === "GET" && url.pathname === "/") {
        return serveDashboard(req, res, url);
      }
      // The workspace dashboard (Preact, single-file build) — parallel to the
      // classic page while it grows to parity; same session gate, same headers.
      if (req.method === "GET" && url.pathname === "/next") {
        return serveDashboard(req, res, url, nextDashboardHtml, "/next");
      }

      const auth = authenticate(req, url.searchParams.get("client"));
      if (auth.kind === "none") return json(res, 401, { error: auth.error });
      if (auth.kind === "client" && !clientMayReach(req.method ?? "", url.pathname)) {
        return json(res, 403, { error: "the owner's surface — not reachable with a client token" });
      }

      if (req.method === "GET" && url.pathname === "/stats") {
        const stats = store.stats();
        if (auth.kind !== "client") return json(res, 200, stats);
        // `bySource` enumerates every other connected client — the owner's
        // view, not a peer's. A revoked client gets no counts at all.
        if (isRevoked(auth.client)) return json(res, 200, { total: 0, byType: {}, bySource: {}, first: null, last: null });
        return json(res, 200, { ...stats, bySource: {} });
      }
      if (req.method === "GET" && url.pathname === "/activity") {
        return json(res, 200, store.activity());
      }
      if (req.method === "GET" && url.pathname === "/topics") {
        const id = scopeFor(auth, url.searchParams.get("client"));
        if (id.error) return json(res, 401, { error: id.error });
        const allowed = id.client ? allowedCategories(id.client) : null;
        let topics = store.topics(num(url, "limit", 50));
        if (allowed) topics = topics.filter((t) => allowed.includes(t.category as Category));
        return json(res, 200, topics);
      }
      if (req.method === "GET" && url.pathname === "/profile") {
        // The holistic profile is cross-category prose — a scoped client gets
        // its scope's own synthesized narrative instead, never the full one.
        const id = scopeFor(auth, url.searchParams.get("client"));
        if (id.error) return json(res, 401, { error: id.error });
        const allowed = id.client ? allowedCategories(id.client) : null;
        if (allowed !== null) {
          const scoped = store.getScopedProfile(scopeKey(allowed));
          if (scoped) return json(res, 200, scoped);
          return json(res, 403, { error: "scoped: no profile synthesized for this scope yet — run `persnally profile` or POST /synthesize", scoped: true });
        }
        const profile = store.getProfile();
        return profile ? json(res, 200, profile) : json(res, 404, { error: "no profile synthesized yet" });
      }
      if (req.method === "GET" && url.pathname === "/skills") {
        // A revoked client reads nothing, consistent with /voice and /stats.
        if (auth.kind === "client" && isRevoked(auth.client)) return json(res, 200, []);
        return json(res, 200, store.skills(num(url, "limit", 25)));
      }
      if (req.method === "GET" && url.pathname === "/voice") {
        // Stylistic, not topical — a scoped client still gets it (it's how you
        // write, not what about). A revoked one does not: "reads nothing" is
        // stated without qualification in the dashboard, so it has to be true.
        if (auth.kind === "client" && isRevoked(auth.client)) return json(res, 200, { pack: "", items: [] });
        return json(res, 200, store.voice());
      }
      if (req.method === "DELETE" && url.pathname.startsWith("/voice/")) {
        const [, , dimension, pattern] = url.pathname.split("/");
        if (!dimension || !pattern) return json(res, 400, { error: "dimension and pattern required" });
        // A client that can't read a pattern can't tombstone it either, and the
        // answer doesn't reveal whether it existed — same rule as /topics/.
        if (auth.kind === "client" && isRevoked(auth.client)) return json(res, 200, { deleted: 0 });
        return json(res, 200, { deleted: store.forgetStyle(dimension, decodeURIComponent(pattern)) });
      }
      if (req.method === "GET" && url.pathname === "/scopes") {
        return json(res, 200, loadScopes());
      }
      // Set a client's category allowlist (empty array = revoke: it reads nothing).
      if (req.method === "POST" && url.pathname === "/scopes") {
        if (!(req.headers["content-type"] ?? "").includes("application/json")) {
          return json(res, 415, { error: "Content-Type must be application/json" });
        }
        const body = (await readBody(req)) as { client?: unknown; categories?: unknown };
        const client = typeof body.client === "string" ? body.client.trim() : "";
        if (!client) return json(res, 400, { error: "client required" });
        if (!Array.isArray(body.categories)) return json(res, 400, { error: "categories must be an array" });
        const cats = body.categories.filter((c): c is Category => CATEGORIES.includes(c as Category));
        if (cats.length !== body.categories.length) {
          return json(res, 400, { error: `unknown category; valid: ${CATEGORIES.join(", ")}` });
        }
        setScope(client, cats);
        return json(res, 200, { client, categories: cats });
      }
      // Clear a client's scope → back to default-open (full access).
      if (req.method === "DELETE" && url.pathname.startsWith("/scopes/")) {
        const client = decodeURIComponent(url.pathname.slice("/scopes/".length));
        if (!client) return json(res, 400, { error: "client required" });
        return json(res, 200, { cleared: clearScope(client) });
      }
      // Import whatever setup had to skip. The dashboard calls this right after
      // an engine is configured (Ollama pull or pasted key) — before this
      // existed it only re-synthesized, so a user who onboarded their engine
      // from the dashboard got a portrait built from git alone and was never
      // told their chat history had been passed over.
      if (req.method === "POST" && url.pathname === "/import") {
        if (importing) return json(res, 409, { error: "an import is already running" });
        const engine = await chooseExtractor("extract").catch(() => null);
        if (!engine) return json(res, 400, { error: "no extraction engine — set a key or pull a local model first" });
        importing = true;
        try {
          const r = await importAllSources(store, engine);
          return json(res, 200, r);
        } finally {
          importing = false;
        }
      }
      if (req.method === "POST" && url.pathname === "/synthesize") {
        const engine = await chooseExtractor("profile");
        const profile = await synthesizeProfile(store, engine.extract, engine.model)
          .then((p) => { recordEngineSuccess(); return p; })
          .catch((e: unknown) => { recordEngineFailure(e); throw e; });
        safeRefreshVoice(store, "dashboard"); // keep "how you write" current with the portrait
        // Scoped caches ride along; per-scope failures are logged, never fatal.
        await refreshScopedProfiles(store, engine.extract, engine.model);
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
          // Resolved here so the dashboard reports the model that runs each
          // job instead of guessing from the tag order.
          models: resolvedModels(key.startsWith("sk-ant-"), tags),
          // A key on file is not a key that works; report the last failure so
          // the dashboard can stop claiming a healthy engine.
          lastFailure: engineFailure(),
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
        const claimed = typeof body.client === "string" && body.client
          ? body.client.toLowerCase().replace(/[^a-z0-9._-]/g, "-")
          : null;
        const id = scopeFor(auth, claimed);
        if (id.error) return json(res, 401, { error: id.error });
        const client = id.client;
        const asker = typeof body.asker === "string" && body.asker ? body.asker : (client ?? "dashboard");
        if (!askAllowed(Date.now())) {
          return json(res, 429, { error: `ask limit reached (${ASK_LIMIT} per ${ASK_WINDOW_MS / 60000} min) — protects your inference budget from a looping agent` });
        }
        const engine = await chooseExtractor("extract").catch(() => null);
        // An ask is an engine call like any other, so its outcome updates the
        // health the dashboard reports. A deferral (no engine, no context) is
        // not a failure and must not be recorded as one.
        let result;
        try {
          result = await askUserModel(store, {
            question,
            asker,
            source: client ? `mcp:${client}` : "dashboard",
            provenance: client ? { kind: "mcp", client } : { kind: "local", surface: "dashboard" },
            allowed: client ? allowedCategories(client) : null,
          }, engine);
          if (engine) recordEngineSuccess();
        } catch (e) {
          recordEngineFailure(e);
          throw e;
        }
        return json(res, 200, result);
      }
      if (req.method === "GET" && url.pathname === "/questions") {
        return json(res, 200, store.askHistory(num(url, "limit", 50)));
      }
      // Targeted lookup — deterministic and offline, so no rate limit needed.
      if (req.method === "GET" && url.pathname === "/search") {
        const q = (url.searchParams.get("q") ?? "").trim();
        if (!q || q.length > 200) return json(res, 400, { error: "q required (1–200 chars)" });
        const id = scopeFor(auth, url.searchParams.get("client"));
        if (id.error) return json(res, 401, { error: id.error });
        return json(res, 200, searchContext(store, q, {
          limit: num(url, "limit", 10),
          allowed: id.client ? allowedCategories(id.client) : null,
        }));
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
        // A client token may only write events attributed to itself. Claiming
        // another client's name poisons provenance; claiming a non-MCP one
        // (`cli`, `dashboard`, `import`, `derived`) forges the owner's own
        // surfaces — and a `user.correction` forged that way is treated as
        // authoritative by synthesis and /ask, outranking everything the
        // engine inferred. Rejected whole-batch, before any write.
        if (auth.kind === "client") {
          const expected = `mcp:${auth.client}`;
          for (const e of events) {
            const claimed = e.provenance.kind === "mcp" ? e.provenance.client
              : e.source.startsWith("mcp:") ? e.source.slice(4)
              : null;
            if (claimed !== null && claimed !== auth.client) {
              return json(res, 401, { error: `token identifies '${auth.client}' but the request claims '${claimed}'` });
            }
            if (e.provenance.kind !== "mcp" || e.source !== expected) {
              return json(res, 403, {
                error: `'${auth.client}' may only write events attributed to itself — expected source '${expected}' with 'mcp' provenance, got '${e.source}' with '${e.provenance.kind}'`,
              });
            }
          }
        }
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
        // The wipe is the owner's alone. Connect is default-open, so allowing
        // it here handed every freshly connected AI the power to irreversibly
        // destroy the user's accumulated model — one prompt injection away,
        // with no undo. Clients keep per-topic and per-style forget, which is
        // what honoring a "delete that" request actually needs.
        if (auth.kind === "client") {
          return json(res, 403, {
            error: `wiping everything is the owner's action, not '${auth.client}'s — do it from the dashboard, or run: persnally forget --all`,
          });
        }
        store.forgetAll();
        return json(res, 200, { deleted: "all" });
      }
      if (req.method === "DELETE" && url.pathname.startsWith("/topics/")) {
        const topic = decodeURIComponent(url.pathname.slice("/topics/".length));
        if (!topic) return json(res, 400, { error: "topic required" });
        // Same rule one route down: a scoped client could otherwise delete a
        // topic in a category it isn't allowed to read. Out-of-scope topics
        // report the same "nothing deleted" as topics that don't exist —
        // answering differently would confirm what the scope exists to hide.
        if (auth.kind === "client") {
          const allowed = allowedCategories(auth.client);
          const category = store.topicCategory(topic);
          if (allowed !== null && (category === null || !allowed.includes(category as Category))) {
            return json(res, 200, { deleted: 0 });
          }
        }
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
    // The attempt timestamp, not the success one: a failing run must back off to
    // daily instead of retrying on every tick.
    const lastAttempt = loadConfig().last_consolidation_attempt;
    if (!shouldRunNow(typeof lastAttempt === "string" ? lastAttempt : undefined, new Date())) return;
    try {
      const engine = await chooseExtractor("extract").catch(() => null);
      const r = await runConsolidation(store, engine);
      safeRefreshVoice(store, "cli"); // nightly: keep the voice fingerprint fresh + clean
      console.error(`consolidation: ${r.newSignals} new signals, ${r.assertions} assertions, profile ${r.profileRefreshed ? "refreshed" : "kept"}, ${r.stylePruned} style signals pruned`);
    } catch (e) {
      recordEngineFailure(e);
      console.error(`consolidation failed (retrying tomorrow, not this hour): ${e instanceof Error ? e.message : String(e)}`);
    }
  }, 30 * 60 * 1000);
  timer.unref();
  server.on("close", () => clearInterval(timer));

  return server;
}

// A pass slower than the 30-minute timer would otherwise overlap the next one:
// duplicate extraction spend, and two writers racing the same source.
let importing = false;

// Import backoff, persisted so it survives the restarts launchd performs freely.
// Doubles from half an hour to a day: a transient outage clears within one cycle,
// a revoked key settles at a couple of attempts a day instead of forty-eight.
const IMPORT_BACKOFF_START_MIN = 30;
const IMPORT_BACKOFF_MAX_MIN = 24 * 60;

function importCooldownUntil(now: number): number {
  const until = loadConfig().import_backoff_until;
  const ms = typeof until === "string" && until ? Date.parse(until) : NaN;
  // An unparseable value must not pause imports forever.
  return Number.isNaN(ms) ? now : ms;
}

function importBackoffActive(): boolean {
  const cfg = loadConfig();
  return !!cfg.import_backoff_until || !!cfg.import_backoff_minutes;
}

function nextImportBackoff(): number {
  const prev = loadConfig().import_backoff_minutes;
  const last = typeof prev === "number" && prev > 0 ? prev : 0;
  return Math.min(last ? last * 2 : IMPORT_BACKOFF_START_MIN, IMPORT_BACKOFF_MAX_MIN);
}

/**
 * Ingest Claude Code sessions created since the last pass — the daemon's
 * automatic capture of new chats (no user action, no per-session hook). A
 * key-less, Ollama-less machine has no extractor: skip rather than block.
 * Never throws — capture must not take the daemon down.
 */
export async function autoImportNewSessions(store: EventStore, now: number = Date.now()): Promise<void> {
  if (importing) {
    console.error("auto-import: previous pass still running — skipping this tick");
    return;
  }
  if (now < importCooldownUntil(now)) return; // engine known-bad; the cooldown was logged when set
  importing = true;
  try {
    const engine = await chooseExtractor("extract").catch(() => null);
    if (!engine) return;
    const r = await importNewClaudeCodeSessions(store, engine.extract, engine.model);
    if (r.engineFailed) {
      // A failed extraction leaves the session unmarked so it retries — right for
      // one bad response, ruinous when the engine is down: the same sessions come
      // back every tick. Back off, doubling while it stays broken.
      const minutes = nextImportBackoff();
      saveConfig({ import_backoff_minutes: minutes, import_backoff_until: new Date(now + minutes * 60_000).toISOString() });
      console.error(`auto-import: extraction engine is failing — pausing imports for ${minutes} min (${r.newSessions + r.toppedUp} session(s) left unimported)`);
      return;
    }
    if (importBackoffActive()) saveConfig({ import_backoff_minutes: 0, import_backoff_until: "" }); // recovered
    if (r.events) {
      store.rebuild();
      console.error(`auto-import: ${r.newSessions} new + ${r.toppedUp} resumed Claude Code session(s) → ${r.events} events`);
    }
  } catch (e) {
    console.error("auto-import failed:", e instanceof Error ? e.message : e);
  } finally {
    // finally, not the end of try: the engine-less path returns early, and a
    // stuck flag would silence auto-import until the next daemon restart.
    importing = false;
  }
}

let cachedHtml: string | undefined;
function dashboardHtml(): string {
  cachedHtml ??= readFileSync(new URL("./dashboard.html", import.meta.url), "utf-8");
  return cachedHtml;
}

let cachedNextHtml: string | undefined;
function nextDashboardHtml(): string {
  cachedNextHtml ??= readFileSync(new URL("./dashboard-next.html", import.meta.url), "utf-8");
  return cachedNextHtml;
}

// The page itself never carries the credential — the key arrives once as ?k=,
// is exchanged for an HttpOnly cookie, and the redirect drops it from the
// address bar so it can't leak through history or a Referer on an outbound link.
const DASHBOARD_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

function serveDashboard(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  page: () => string = dashboardHtml,
  selfPath = "/",
): void {
  const key = url.searchParams.get("k");
  if (key && verifyDashboardKey(key)) {
    res.writeHead(302, {
      ...DASHBOARD_HEADERS,
      "Location": selfPath,
      "Set-Cookie": `${SESSION_COOKIE}=${createSession()}; Path=/; Max-Age=${SESSION_TTL_SECONDS}; HttpOnly; SameSite=Strict`,
    });
    res.end();
    return;
  }
  const session = cookie(req, SESSION_COOKIE);
  if (session && sessionValid(session)) {
    // Sliding expiry: past halfway, hand back a fresh cookie. Someone who opens
    // the dashboard even occasionally is never asked to re-authenticate, while
    // a cookie that stops being used still ages out on its own.
    const headers: Record<string, string> = { ...DASHBOARD_HEADERS };
    if (sessionNeedsRefresh(session)) {
      headers["Set-Cookie"] = `${SESSION_COOKIE}=${createSession()}; Path=/; Max-Age=${SESSION_TTL_SECONDS}; HttpOnly; SameSite=Strict`;
    }
    res.writeHead(200, headers);
    res.end(page());
    return;
  }
  res.writeHead(401, DASHBOARD_HEADERS);
  res.end(LOCKED_PAGE);
}

// Static, self-contained: a bookmark that outlives its session lands here.
const LOCKED_PAGE = `<!doctype html><meta charset="utf-8"><title>Persnally — locked</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{color-scheme:dark}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0a0a0b;color:#e7e7e9;
  font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
main{max-width:31rem;padding:2rem;text-align:center}
h1{margin:0 0 .75rem;font-size:1.25rem;font-weight:600;letter-spacing:-.01em}
p{margin:0 0 1.25rem;color:#9a9aa2}
code{display:inline-block;padding:.6rem 1rem;border:1px solid #26262b;border-radius:.5rem;background:#131316;
  color:#e7e7e9;font:14px/1 ui-monospace,SFMono-Regular,Menlo,monospace}
</style>
<main>
  <h1>Your dashboard is locked</h1>
  <p>This page needs a session from your own machine. Open it from the terminal:</p>
  <code>persnally dashboard</code>
</main>`;

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
