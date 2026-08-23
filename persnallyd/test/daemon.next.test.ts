/**
 * The workspace dashboard route (/next) sits behind the exact same session
 * gate as the classic page — a client bearer token must never render the
 * owner surface, and an unauthenticated hit gets the locked page, never data.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { startDaemon } from "../src/daemon.js";
import { createSession, dashboardKey, issueToken, SESSION_COOKIE } from "../src/permissions.js";
import { EventStore } from "../src/store.js";

const dir = mkdtempSync(join(tmpdir(), "daemon-next-test-"));
process.env.PERSNALLY_DIR = dir;
delete process.env.ANTHROPIC_API_KEY;

const PORT = 49881;
const BASE = `http://127.0.0.1:${PORT}`;
const store = new EventStore(join(dir, "test.db"));
let server: ReturnType<typeof startDaemon>;
let key: string;
let clientToken: string;

const asOwner = () => ({ cookie: `${SESSION_COOKIE}=${createSession()}` });

before(() => {
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

describe("GET /next — the workspace dashboard", () => {
  test("unauthenticated → 401 locked page, never data, never demo", async () => {
    const r = await fetch(BASE + "/next");
    assert.equal(r.status, 401);
    const body = await r.text();
    assert.match(body, /locked/i);
    assert.doesNotMatch(body, /DEMO/);
  });

  test("?k= exchanges for an HttpOnly cookie and redirects back to /next", async () => {
    const r = await fetch(`${BASE}/next?k=${key}`, { redirect: "manual" });
    assert.equal(r.status, 302);
    assert.equal(r.headers.get("location"), "/next");
    const setCookie = r.headers.get("set-cookie") ?? "";
    assert.match(setCookie, new RegExp(`^${SESSION_COOKIE}=`));
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
  });

  test("a wrong key gets the locked page, not a redirect", async () => {
    const r = await fetch(`${BASE}/next?k=nope`, { redirect: "manual" });
    assert.equal(r.status, 401);
  });

  test("a valid session renders the SPA shell", async () => {
    const r = await fetch(BASE + "/next", { headers: asOwner() });
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") ?? "", /text\/html/);
    assert.equal(r.headers.get("cache-control"), "no-store");
    const body = await r.text();
    assert.match(body, /persnally/i);
    assert.match(body, /<div id="app">/);
  });

  test("a client bearer token must never render the owner surface", async () => {
    const r = await fetch(BASE + "/next", { headers: { authorization: `Bearer ${clientToken}` } });
    assert.equal(r.status, 401, "bearer tokens don't mint dashboard sessions");
    assert.match(await r.text(), /locked/i);
  });

  test("an unrecognized Host is refused before any page is served", async () => {
    // fetch() refuses to override Host — a raw request is the only way to
    // prove the DNS-rebinding guard (same technique as daemon.auth.test.ts).
    const r = await new Promise<{ status: number }>((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port: PORT, path: "/next", headers: { Host: "evil.example", ...asOwner() } },
        (res) => {
          res.resume();
          res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
        },
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(r.status, 403);
  });
});
