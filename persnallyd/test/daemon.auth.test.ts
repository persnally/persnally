/**
 * The daemon's authentication boundary. Loopback binding is not a credential —
 * the port is reachable by every process and every user on the machine — so
 * every route except /health and the dashboard bootstrap must demand one.
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { saveConfig } from "../src/config.js";
import { startDaemon } from "../src/daemon.js";
import { newEvent } from "../src/events.js";
import {
  clearScope, createSession, dashboardKey, issueToken, rotateDashboardKey,
  SESSION_COOKIE, SESSION_TTL_SECONDS, sessionValid, setScope, verifyDashboardKey,
} from "../src/permissions.js";
import { EventStore } from "../src/store.js";

const dir = mkdtempSync(join(tmpdir(), "daemon-auth-test-"));
process.env.PERSNALLY_DIR = dir;
delete process.env.ANTHROPIC_API_KEY;

const PORT = 49877;
const BASE = `http://127.0.0.1:${PORT}`;
const store = new EventStore(join(dir, "test.db"));
let server: ReturnType<typeof startDaemon>;
let key: string;
let clientToken: string;

const topicEvent = newEvent("signal.topic", "import:claude", {
  topic: "rust", weight: 0.9, intent: "building", sentiment: "positive",
  depth: "deep", category: "technology", entities: [],
}, { kind: "import", batch: "b1", file: "conversations.json" });

/** A browser session, exactly as the ?k= bootstrap would mint it. */
const asOwner = () => ({ cookie: `${SESSION_COOKIE}=${createSession()}` });
const asBearer = (token: string) => ({ authorization: `Bearer ${token}` });

before(() => {
  store.append([topicEvent]);
  store.rebuild();
  server = startDaemon(store, PORT);
  key = dashboardKey();
  clientToken = issueToken("cursor");
});
after(() => {
  server.close();
  store.close();
  delete process.env.PERSNALLY_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("dashboard key and sessions", () => {
  test("the key is minted at daemon start and verifies constant-time", () => {
    assert.ok(key.length >= 32, "key should be a 24-byte base64url secret");
    assert.equal(verifyDashboardKey(key), true);
    assert.equal(verifyDashboardKey("wrong"), false);
    assert.equal(verifyDashboardKey(""), false);
    // Same length, different value — guards against a length-only comparison.
    assert.equal(verifyDashboardKey("x".repeat(key.length)), false);
  });

  test("sessions validate, expire, and are unforgeable", () => {
    const ttl = SESSION_TTL_SECONDS * 1000;
    const id = createSession(1_000);
    assert.equal(sessionValid(id, 1_000), true);
    assert.equal(sessionValid(id, 1_000 + ttl - 1), true);
    assert.equal(sessionValid(id, 1_000 + ttl), false, "expired at TTL");
    assert.equal(sessionValid("not-a-session"), false);
    assert.equal(sessionValid(""), false);
  });

  // The eviction test that used to live here is gone on purpose: sessions are
  // stateless now, so there is no map to bound and no soonest-expiry eviction —
  // which was itself a third silent-logout path.

  test("a tampered cookie is refused — expiry can't be extended, signature can't be forged", () => {
    const id = createSession(1_000);
    const [v, expiry, sig] = id.split(".");

    // Push the expiry far into the future, keeping the original signature.
    assert.equal(sessionValid(`${v}.${Number(expiry) + 10 ** 9}.${sig}`, 1_000), false, "expiry is signed");
    // Keep the payload, forge the signature.
    assert.equal(sessionValid(`${v}.${expiry}.${"A".repeat(sig!.length)}`, 1_000), false);
    // Wrong version prefix.
    assert.equal(sessionValid(`v2.${expiry}.${sig}`, 1_000), false);
    // Structurally broken values must not throw.
    for (const junk of ["...", "v1.", "v1.abc.def", ".", "v1"]) {
      assert.doesNotThrow(() => sessionValid(junk, 1_000));
      assert.equal(sessionValid(junk, 1_000), false, `"${junk}" must not validate`);
    }
  });

  test("a session survives a daemon restart — the bug this design replaces", async () => {
    const id = createSession();
    assert.equal(sessionValid(id), true);

    // A genuinely separate process, with no shared memory: the old in-memory
    // Map made this impossible, so every relaunch logged the user out.
    const { execFileSync } = await import("node:child_process");
    const permissions = new URL("../src/permissions.js", import.meta.url).pathname;
    const out = execFileSync(process.execPath, [
      "-e",
      // Written raw, not console.log'd: npm sets FORCE_COLOR for its scripts
      // under a TTY, and the inspector wraps a bare boolean in ANSI codes.
      `import(${JSON.stringify(permissions)}).then((m) => process.stdout.write(String(m.sessionValid(process.argv[1]))))`,
      id,
    ], { encoding: "utf-8", env: { ...process.env, PERSNALLY_DIR: dir } }).trim();

    assert.equal(out, "true", "a fresh process must accept a session minted before it started");
  });

  test("rotating the key invalidates the old key and every live session", () => {
    const live = createSession();
    const old = dashboardKey();
    const fresh = rotateDashboardKey();
    assert.notEqual(fresh, old);
    assert.equal(verifyDashboardKey(old), false);
    assert.equal(verifyDashboardKey(fresh), true);
    assert.equal(sessionValid(live), false, "sessions die with the key that minted them");
    key = fresh; // keep the rest of the suite on the current key
  });

  test("a rotation in another process still invalidates live sessions", () => {
    // The CLI rotates; the daemon holds the sessions. Clearing an in-process map
    // can't reach across, so validity is bound to the key's fingerprint instead.
    const live = createSession();
    assert.equal(sessionValid(live), true);
    saveConfig({ dashboard_key: randomBytes(24).toString("base64url") }); // as another process would
    assert.equal(sessionValid(live), false, "session dies when the key changes underneath it");
    key = dashboardKey();
  });
});

describe("dashboard bootstrap", () => {
  test("bare GET / is locked, and does not leak the page", async () => {
    const r = await fetch(BASE + "/", { redirect: "manual" });
    assert.equal(r.status, 401);
    const body = await r.text();
    assert.match(body, /locked/i);
    assert.doesNotMatch(body, /DEMO_DATA/, "must not serve the real dashboard");
    assert.equal(r.headers.get("cache-control"), "no-store");
  });

  test("?k= exchanges the key for an HttpOnly session and redirects it out of the URL", async () => {
    const r = await fetch(`${BASE}/?k=${key}`, { redirect: "manual" });
    assert.equal(r.status, 302);
    assert.equal(r.headers.get("location"), "/");
    const cookie = r.headers.get("set-cookie") ?? "";
    assert.match(cookie, new RegExp(`^${SESSION_COOKIE}=`));
    assert.match(cookie, /HttpOnly/, "JS must not be able to read it");
    assert.match(cookie, /SameSite=Strict/, "must not ride cross-site requests");
    assert.equal(r.headers.get("referrer-policy"), "no-referrer", "the key must not leak via Referer");
    assert.doesNotMatch(cookie, new RegExp(key), "the key itself is never the cookie");
  });

  test("a wrong ?k= stays locked", async () => {
    const r = await fetch(`${BASE}/?k=nope`, { redirect: "manual" });
    assert.equal(r.status, 401);
    assert.equal(r.headers.get("set-cookie"), null);
  });

  test("the session cookie then serves the real dashboard", async () => {
    const r = await fetch(BASE + "/", { headers: asOwner() });
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await r.text(), /persnally/);
  });

  test("a fresh session is served without re-issuing a cookie", async () => {
    const r = await fetch(BASE + "/", { headers: asOwner() });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("set-cookie"), null, "nothing to refresh yet — don't churn the cookie");
  });

  test("a session past halfway is silently renewed, so an active user never re-authenticates", async () => {
    // Minted far enough in the past that it is over halfway to expiry but not
    // yet expired — exactly the window the old 12h hard TTL had no answer for.
    const ttl = SESSION_TTL_SECONDS * 1000;
    const aging = createSession(Date.now() - (ttl * 0.75));

    const r = await fetch(BASE + "/", { headers: { cookie: `${SESSION_COOKIE}=${aging}` } });

    assert.equal(r.status, 200);
    const setCookie = r.headers.get("set-cookie") ?? "";
    assert.match(setCookie, new RegExp(`^${SESSION_COOKIE}=`), "a renewed cookie is issued");
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    const renewed = setCookie.slice(SESSION_COOKIE.length + 1).split(";")[0]!;
    assert.notEqual(renewed, aging, "and it is genuinely a new session, not the same value echoed back");
    assert.equal(sessionValid(renewed), true);
  });
});

describe("every route demands a credential", () => {
  test("/health stays open — lifecycle probes it before any credential exists", async () => {
    const r = await fetch(BASE + "/health");
    assert.equal(r.status, 200);
    assert.equal(((await r.json()) as { ok: boolean }).ok, true);
  });

  // The gap this suite exists to close: these were all reachable unauthenticated.
  const reads = ["/stats", "/activity", "/voice", "/questions", "/scopes", "/engine",
    "/topics", "/profile", "/events", "/events?ids=x", "/search?q=rust"];
  for (const path of reads) {
    test(`GET ${path} is 401 without a credential`, async () => {
      const r = await fetch(BASE + path);
      assert.equal(r.status, 401);
      assert.match(((await r.json()) as { error: string }).error, /authentication required/);
    });
  }

  const mutations: Array<[string, string]> = [
    ["POST", "/synthesize"], ["POST", "/consolidate"], ["POST", "/engine/key"],
    ["POST", "/engine/pull"], ["POST", "/feedback"], ["POST", "/scopes"], ["POST", "/ask"],
    ["DELETE", "/events?confirm=all"], ["DELETE", "/topics/rust"],
    ["DELETE", "/voice/voice/terse"], ["DELETE", "/scopes/cursor"],
  ];
  for (const [method, path] of mutations) {
    test(`${method} ${path} is 401 without a credential`, async () => {
      const r = await fetch(BASE + path, {
        method,
        headers: { "Content-Type": "application/json" },
        body: method === "POST" ? "{}" : undefined,
      });
      assert.equal(r.status, 401);
    });
  }

  test("the destructive wipe is refused unauthenticated — and the store survives", async () => {
    const before = store.stats().total;
    const r = await fetch(`${BASE}/events?confirm=all`, { method: "DELETE" });
    assert.equal(r.status, 401);
    assert.equal(store.stats().total, before, "nothing was deleted");
  });

  test("an unknown bearer token is refused with an actionable message", async () => {
    const r = await fetch(BASE + "/topics", { headers: asBearer("bogus-token") });
    assert.equal(r.status, 401);
    assert.match(((await r.json()) as { error: string }).error, /unrecognized token/);
  });

  test("a tokened client that omits its token is told exactly what to run", async () => {
    const r = await fetch(BASE + "/topics?client=cursor");
    assert.equal(r.status, 401);
    assert.match(((await r.json()) as { error: string }).error, /persnally connect cursor/);
  });
});

describe("owner access", () => {
  test("the session reads every owner route", async () => {
    for (const path of ["/stats", "/activity", "/voice", "/questions", "/scopes", "/topics", "/events"]) {
      const r = await fetch(BASE + path, { headers: asOwner() });
      assert.equal(r.status, 200, `${path} should be readable by the owner`);
    }
  });

  test("the dashboard key works as a bearer, for local scripts", async () => {
    const r = await fetch(BASE + "/stats", { headers: asBearer(key) });
    assert.equal(r.status, 200);
  });

  test("the owner reads unscoped even when a client of that name is scoped", async () => {
    setScope("cursor", ["health"]);
    const topics = await (await fetch(BASE + "/topics?client=cursor", { headers: asOwner() })).json() as unknown[];
    assert.equal(topics.length, 1, "owner sees the technology topic a scoped client could not");
  });
});

describe("client tokens reach only the client surface", () => {
  test("a client token reads its own routes", async () => {
    setScope("cursor", ["technology"]);
    for (const path of ["/topics", "/voice", "/stats", "/search?q=rust"]) {
      const r = await fetch(BASE + path, { headers: asBearer(clientToken) });
      assert.equal(r.status, 200, `${path} should be reachable by a client`);
    }
  });

  test("a client token cannot read the raw event log — the scope bypass is closed", async () => {
    const r = await fetch(BASE + "/events", { headers: asBearer(clientToken) });
    assert.equal(r.status, 403);
    assert.match(((await r.json()) as { error: string }).error, /owner's surface/);
  });

  test("a client token cannot widen its own grant", async () => {
    const r = await fetch(BASE + "/scopes", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...asBearer(clientToken) },
      body: JSON.stringify({ client: "cursor", categories: [] }),
    });
    assert.equal(r.status, 403);
    const still = await (await fetch(BASE + "/scopes", { headers: asOwner() })).json() as Record<string, string[]>;
    assert.deepEqual(still["cursor"], ["technology"], "grant unchanged");
  });

  // /import spends inference and reads ~/Downloads — the owner's surface, not a
  // connected AI's. It exists so the dashboard can finish onboarding an engine.
  test("a client token cannot trigger an import", async () => {
    const r = await fetch(BASE + "/import", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...asBearer(clientToken) },
      body: "{}",
    });
    assert.equal(r.status, 403);
    assert.match(((await r.json()) as { error: string }).error, /owner's surface/);
  });

  // Deliberately not exercising the owner path here: it resolves a real engine
  // and imports the machine's real ~/Downloads, so the result would depend on
  // whether the developer happens to have Ollama running (it hung locally for
  // exactly that reason). The import logic itself is covered deterministically
  // in import-all-sources.test.ts; this suite covers the boundary.

  test("a client token cannot spend inference or read the engine's key state", async () => {
    for (const path of ["/synthesize", "/consolidate"]) {
      const r = await fetch(BASE + path, { method: "POST", headers: { "Content-Type": "application/json", ...asBearer(clientToken) }, body: "{}" });
      assert.equal(r.status, 403, `${path} must be owner-only`);
    }
    assert.equal((await fetch(BASE + "/engine", { headers: asBearer(clientToken) })).status, 403);
  });

  test("a client token still gets its scope applied, from the token not the query", async () => {
    setScope("cursor", ["health"]);
    const topics = await (await fetch(BASE + "/topics", { headers: asBearer(clientToken) })).json() as unknown[];
    assert.equal(topics.length, 0, "scoped out of technology");
    setScope("cursor", ["technology"]);
  });

  test("a token cannot act under another client's name", async () => {
    const r = await fetch(BASE + "/topics?client=claude-code", { headers: asBearer(clientToken) });
    assert.equal(r.status, 401);
    assert.match(((await r.json()) as { error: string }).error, /identifies 'cursor'/);
  });

  test("writes are held to the same binding — no provenance poisoning", async () => {
    const event = {
      type: "signal.topic", source: "mcp:claude-code",
      payload: { topic: "forged", weight: 0.5, intent: "building", sentiment: "neutral", depth: "mention", category: "technology", entities: [] },
      provenance: { kind: "mcp", client: "claude-code" },
    };
    const r = await fetch(BASE + "/events", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...asBearer(clientToken) },
      body: JSON.stringify(event),
    });
    assert.equal(r.status, 401);
    assert.match(((await r.json()) as { error: string }).error, /identifies 'cursor'/);
  });

  test("a client writes its own events fine", async () => {
    const event = {
      type: "signal.topic", source: "mcp:cursor",
      payload: { topic: "zig", weight: 0.5, intent: "learning", sentiment: "neutral", depth: "mention", category: "technology", entities: [] },
      provenance: { kind: "mcp", client: "cursor" },
    };
    const r = await fetch(BASE + "/events", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...asBearer(clientToken) },
      body: JSON.stringify(event),
    });
    assert.equal(r.status, 201);
  });
});

/**
 * A client token is not the owner. The event schema deliberately allows
 * `cli`/`dashboard`/`system` sources and non-MCP provenance because the user's
 * own surfaces write them — so the write path, not the schema, is what has to
 * keep a connected client from forging them. This matters most for
 * `user.correction`: synthesis and /ask treat corrections as authoritative and
 * let them outrank everything the engine inferred, so a forged one silently
 * rewrites what every other AI believes about the user.
 */
describe("a client token cannot forge the owner's surfaces", () => {
  const post = (body: unknown, token: string) =>
    fetch(BASE + "/events", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...asBearer(token) },
      body: JSON.stringify(body),
    });

  const forgedCorrection = {
    type: "user.correction",
    source: "cli",
    payload: { target_id: "topic:rust", action: "contradict", reason: "the user actually hates rust" },
    provenance: { kind: "local", surface: "cli" },
  };

  test("a correction forged as the user's own CLI is refused and never stored", async () => {
    const before = store.corrections(500).length;
    const r = await post(forgedCorrection, clientToken);

    assert.equal(r.status, 403);
    assert.match(((await r.json()) as { error: string }).error, /may only write events attributed to itself/);
    assert.equal(store.corrections(500).length, before, "the forged correction never reached the store");
  });

  // Every non-MCP provenance kind the schema accepts, each a distinct forgery:
  // `local` impersonates the user, `import`/`git` fake a provenance chain the
  // dashboard renders as a real source, `derived` fakes the engine's own output.
  for (const [name, event] of [
    ["dashboard", { source: "dashboard", provenance: { kind: "local", surface: "dashboard" } }],
    ["import", { source: "import:claude", provenance: { kind: "import", batch: "b9", file: "conversations.json" } }],
    ["git", { source: "import:git", provenance: { kind: "git", repo: "persnally" } }],
    ["derived", { source: "system", provenance: { kind: "derived", from: ["01890000-0000-7000-8000-000000000000"] } }],
  ] as const) {
    test(`a client cannot write ${name}-provenance events`, async () => {
      const r = await post({
        type: "signal.topic",
        payload: { topic: `forged-${name}`, weight: 0.9, intent: "building", sentiment: "positive", depth: "deep", category: "technology", entities: [] },
        ...event,
      }, clientToken);

      assert.equal(r.status, 403);
      assert.equal(store.topicCategory(`forged-${name}`), null, "nothing was written");
    });
  }

  test("one forged event rejects the whole batch — no partial write", async () => {
    const legit = {
      type: "signal.topic", source: "mcp:cursor",
      payload: { topic: "batch-legit", weight: 0.5, intent: "learning", sentiment: "neutral", depth: "mention", category: "technology", entities: [] },
      provenance: { kind: "mcp", client: "cursor" },
    };
    const r = await post([legit, forgedCorrection], clientToken);

    assert.equal(r.status, 403);
    assert.equal(store.topicCategory("batch-legit"), null, "the legitimate event in the batch was not written either");
  });

  test("the owner still writes its own surfaces freely", async () => {
    const before = store.corrections(500).length;
    const r = await fetch(BASE + "/events", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...asOwner() },
      body: JSON.stringify(forgedCorrection),
    });

    assert.equal(r.status, 201, "a cli-sourced correction is exactly what `persnallyd correct` writes");
    assert.equal(store.corrections(500).length, before + 1);
  });
});

/**
 * The dashboard states "revoked — reads nothing" without qualification, and the
 * revoke confirmation repeats it. Everything a revoked client can still reach
 * makes that copy a lie, which is the claim the whole custody pitch rests on.
 */
describe("revoked means revoked", () => {
  const revoked = () => { setScope("revoked-client", []); return issueToken("revoked-client"); };

  before(() => {
    // A style signal to be revoked *from* — otherwise an empty pack proves nothing.
    store.append([newEvent("signal.style", "import:claude", {
      dimension: "voice", pattern: "terse imperatives", polarity: "does",
      confidence: 0.9, evidence: "sampled across 3k prompts", basis: "stylometry",
    }, { kind: "import", batch: "b5", file: "conversations.json" })]);
  });

  test("the style pack is not served to a revoked client", async () => {
    const token = revoked();
    assert.ok(store.voice().items.length > 0, "the owner has voice signals to leak");

    const r = await fetch(BASE + "/voice", { headers: asBearer(token) });

    assert.equal(r.status, 200);
    const body = (await r.json()) as { pack: string; items: unknown[] };
    assert.equal(body.items.length, 0, "the most prescriptive layer we hold");
    assert.equal(body.pack, "");
  });

  test("a scoped-but-not-revoked client still gets style — it is how you write, not what about", async () => {
    setScope("cursor", ["technology"]);
    const r = await fetch(BASE + "/voice", { headers: asBearer(clientToken) });
    assert.equal(r.status, 200);
    assert.ok(((await r.json()) as { items: unknown[] }).items.length > 0, "the deliberate exception is preserved");
  });

  test("a revoked client cannot tombstone a style pattern", async () => {
    const token = revoked();
    const before = store.voice().items.length;

    const r = await fetch(`${BASE}/voice/voice/${encodeURIComponent("terse imperatives")}`, {
      method: "DELETE", headers: asBearer(token),
    });

    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { deleted: 0 }, "and the answer doesn't confirm it exists");
    assert.equal(store.voice().items.length, before, "the pattern survived");
  });

  test("the context pack is not served to a revoked client", async () => {
    const token = revoked();
    // The route had no revocation check of its own. The pack gated only its
    // category-tagged sections on the grant, so style and conventions — the
    // most prescriptive things we hold — went out to a revoked client.
    const r = await fetch(BASE + "/context", { headers: asBearer(token) });

    assert.equal(r.status, 200);
    const body = (await r.json()) as { text: string; items: number };
    assert.equal(body.text, "", "served the pack to a client promised it reads nothing");
    assert.equal(body.items, 0);
  });

  test("an ask from a revoked client discloses nothing, even naming a project", async () => {
    const token = revoked();
    // Naming a project is the widest disclosure the ask path has: it selects
    // that project's conventions specifically.
    const r = await fetch(BASE + "/ask", {
      method: "POST",
      headers: { ...asBearer(token), "content-type": "application/json" },
      body: JSON.stringify({ question: "Which package manager do I use here?", project: "/tmp/whatever" }),
    });

    assert.equal(r.status, 200);
    const body = (await r.json()) as { deferred: boolean; answer: string; evidence: unknown[] };
    assert.equal(body.deferred, true, "answered a revoked client from the owner's conventions");
    assert.deepEqual(body.evidence ?? [], [], "and cited the owner's events while doing it");
    assert.doesNotMatch(body.answer, /terse imperatives/);
  });

  test("a revoked client gets no counts", async () => {
    const token = revoked();
    assert.ok(store.stats().total > 0, "the owner has events to leak");

    const r = await fetch(BASE + "/stats", { headers: asBearer(token) });

    assert.equal(((await r.json()) as { total: number }).total, 0);
  });

  test("no client sees which other clients are connected", async () => {
    setScope("cursor", ["technology"]);
    const asClient = (await (await fetch(BASE + "/stats", { headers: asBearer(clientToken) })).json()) as { bySource: Record<string, number>; total: number };
    const asOwnerStats = (await (await fetch(BASE + "/stats", { headers: asOwner() })).json()) as { bySource: Record<string, number> };

    assert.deepEqual(asClient.bySource, {}, "bySource enumerates every other connected client");
    assert.ok(asClient.total > 0, "a scoped client still gets its own counts");
    assert.ok(Object.keys(asOwnerStats.bySource).length > 0, "the owner still sees the full breakdown");
  });
});

describe("the browser guards still hold", () => {
  // fetch() will not forward Origin on a GET, nor override Host at all — raw
  // requests are the only way to prove these guards from a test.
  const raw = (path: string, headers: Record<string, string>) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: PORT, path, headers }, (res) => {
        let body = "";
        res.on("data", (c) => { body += c; });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on("error", reject);
      req.end();
    });

  test("a foreign Origin is refused even with a valid session", async () => {
    const r = await raw("/stats", { Origin: "http://evil.example", ...asOwner() });
    assert.equal(r.status, 403);
    assert.match(r.body, /cross-origin/);
  });

  test("a foreign Host is refused (DNS rebinding)", async () => {
    const r = await raw("/stats", { Host: "evil.example", ...asOwner() });
    assert.equal(r.status, 403);
    assert.match(r.body, /Host/);
  });

  test("the loopback Origin still passes", async () => {
    const r = await raw("/stats", { Origin: BASE, ...asOwner() });
    assert.equal(r.status, 200);
  });
});

describe("destructive actions respect the client's scope", () => {
  // A client that cannot read a category must not be able to destroy it.
  const scopedToken = () => { setScope("editor-z", ["technology"]); return issueToken("editor-z"); };
  const openToken = () => { clearScope("editor-open"); return issueToken("editor-open"); };

  const health = () => newEvent("signal.topic", "import:claude", {
    topic: "therapy", weight: 0.8, intent: "learning", sentiment: "positive",
    depth: "deep", category: "health", entities: [],
  }, { kind: "import", batch: "b2", file: "conversations.json" });

  test("a scoped client cannot wipe the store, and nothing is deleted", async () => {
    const token = scopedToken();
    const before = store.stats().total;
    const r = await fetch(`${BASE}/events?confirm=all`, { method: "DELETE", headers: asBearer(token) });
    assert.equal(r.status, 403);
    assert.match(((await r.json()) as { error: string }).error, /owner's action/);
    assert.equal(store.stats().total, before, "the store survived");
  });

  test("a scoped client cannot delete a topic outside its categories", async () => {
    const token = scopedToken();
    const t = health();
    store.append([t]);
    store.rebuild();
    assert.equal(store.topicCategory("therapy"), "health");

    const r = await fetch(`${BASE}/topics/therapy`, { method: "DELETE", headers: asBearer(token) });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { deleted: 0 }, "reports nothing deleted, not a 403");
    assert.equal(store.topicCategory("therapy"), "health", "the out-of-scope topic still exists");
  });

  test("an out-of-scope topic is indistinguishable from one that doesn't exist", async () => {
    const token = scopedToken();
    const outOfScope = await (await fetch(`${BASE}/topics/therapy`, { method: "DELETE", headers: asBearer(token) })).json();
    const nonexistent = await (await fetch(`${BASE}/topics/does-not-exist-at-all`, { method: "DELETE", headers: asBearer(token) })).json();
    assert.deepEqual(outOfScope, nonexistent, "the response must not confirm the topic exists");
  });

  test("a scoped client can still delete a topic inside its categories", async () => {
    const token = scopedToken();
    const t = newEvent("signal.topic", "import:claude", {
      topic: "zig lang", weight: 0.7, intent: "learning", sentiment: "positive",
      depth: "deep", category: "technology", entities: [],
    }, { kind: "import", batch: "b3", file: "conversations.json" });
    store.append([t]);
    store.rebuild();
    const r = await fetch(`${BASE}/topics/zig%20lang`, { method: "DELETE", headers: asBearer(token) });
    assert.equal(r.status, 200);
    assert.equal(((await r.json()) as { deleted: number }).deleted, 1, "in-scope forget still works");
    assert.equal(store.topicCategory("zig lang"), null, "and really deleted it");
  });

  // Connect is default-open, so an unscoped client used to hold the wipe the
  // moment it was connected — a single prompt injection from destroying months
  // of accumulated model, with no undo. The wipe is the owner's alone now.
  test("an unscoped client cannot wipe the store either", async () => {
    const token = openToken();
    store.append([health()]);
    store.rebuild();
    const before = store.stats().total;

    const r = await fetch(`${BASE}/events?confirm=all`, { method: "DELETE", headers: asBearer(token) });

    assert.equal(r.status, 403);
    assert.match(((await r.json()) as { error: string }).error, /owner's action/);
    assert.equal(store.stats().total, before, "the store survived");
  });

  test("clients keep the per-topic forget they need to honor 'delete that'", async () => {
    const token = openToken();
    store.append([newEvent("signal.topic", "import:claude", {
      topic: "temp topic", weight: 0.7, intent: "learning", sentiment: "neutral",
      depth: "moderate", category: "technology", entities: [],
    }, { kind: "import", batch: "b4", file: "conversations.json" })]);
    store.rebuild();

    const r = await fetch(`${BASE}/topics/temp%20topic`, { method: "DELETE", headers: asBearer(token) });

    assert.equal(r.status, 200);
    assert.equal(((await r.json()) as { deleted: number }).deleted, 1);
    assert.equal(store.topicCategory("temp topic"), null);
  });

  test("the owner keeps the wipe", async () => {
    store.append([health()]);
    store.rebuild();
    const r = await fetch(`${BASE}/events?confirm=all`, { method: "DELETE", headers: asOwner() });
    assert.equal(r.status, 200);
    assert.equal(store.stats().total, 0);
  });
});
