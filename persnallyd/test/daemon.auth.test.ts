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
  clearScope, clearSessions, createSession, dashboardKey, issueToken, rotateDashboardKey,
  SESSION_COOKIE, sessionValid, setScope, verifyDashboardKey,
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
    const id = createSession(1_000);
    assert.equal(sessionValid(id, 1_000), true);
    assert.equal(sessionValid(id, 1_000 + 12 * 3600 * 1000 - 1), true);
    assert.equal(sessionValid(id, 1_000 + 12 * 3600 * 1000), false, "expired at TTL");
    assert.equal(sessionValid("not-a-session"), false);
    assert.equal(sessionValid(""), false);
  });

  test("the session map is bounded, evicting the soonest to expire", () => {
    clearSessions();
    const first = createSession(1_000);
    for (let i = 0; i < 40; i++) createSession(2_000 + i);
    assert.equal(sessionValid(first, 3_000), false, "oldest evicted past the cap");
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
    assert.match(((await r.json()) as { error: string }).error, /persnallyd connect cursor/);
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
    assert.match(((await r.json()) as { error: string }).error, /can't delete data it can't read/);
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

  test("an unscoped client keeps the wipe — the grant it always had", async () => {
    const token = openToken();
    store.append([health()]);
    store.rebuild();
    const r = await fetch(`${BASE}/events?confirm=all`, { method: "DELETE", headers: asBearer(token) });
    assert.equal(r.status, 200);
    assert.equal(store.stats().total, 0, "an unscoped client may still wipe");
  });

  test("the owner keeps the wipe", async () => {
    store.append([health()]);
    store.rebuild();
    const r = await fetch(`${BASE}/events?confirm=all`, { method: "DELETE", headers: asOwner() });
    assert.equal(r.status, 200);
    assert.equal(store.stats().total, 0);
  });
});
