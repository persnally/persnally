import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { startDaemon } from "../src/daemon.js";
import { newEvent } from "../src/events.js";
import { allowedCategories, clearScope, clientForToken, createSession, hasToken, isAllowed, issueToken, loadScopes, SESSION_COOKIE, setScope } from "../src/permissions.js";
import { EventStore } from "../src/store.js";

const dir = mkdtempSync(join(tmpdir(), "perms-test-"));
process.env.PERSNALLY_DIR = dir; // config (scopes) resolves here, in-process
after(() => { delete process.env.PERSNALLY_DIR; rmSync(dir, { recursive: true, force: true }); });

describe("scope storage", () => {
  test("default-open: unknown client sees everything", () => {
    assert.equal(allowedCategories("fresh-client"), null);
    assert.equal(isAllowed("fresh-client", "health"), true);
  });

  test("set/clear scope round-trips and enforces", () => {
    setScope("editor-x", ["technology", "career"]);
    assert.deepEqual(allowedCategories("editor-x"), ["technology", "career"]);
    assert.equal(isAllowed("editor-x", "technology"), true);
    assert.equal(isAllowed("editor-x", "health"), false);
    assert.ok(Object.keys(loadScopes()).includes("editor-x"));
    assert.equal(clearScope("editor-x"), true);
    assert.equal(allowedCategories("editor-x"), null, "cleared = unrestricted again");
    assert.equal(clearScope("editor-x"), false, "clearing twice is a no-op");
  });
});

describe("daemon enforcement", () => {
  const PORT = 49855;
  const BASE = `http://127.0.0.1:${PORT}`;
  const store = new EventStore(join(dir, "test.db"));
  let server: ReturnType<typeof startDaemon>;
  let cursorToken: string;
  let desktopToken: string;

  const topic = (name: string, category: string) =>
    newEvent("signal.topic", "import:claude", {
      topic: name, weight: 0.8, intent: "building", sentiment: "positive",
      depth: "deep", category, entities: [],
    }, { kind: "import", batch: "b1", file: "conversations.json" });

  // A client's scope now follows its token, never a self-reported ?client=, so
  // enforcement is tested through real credentials. The owner reads unscoped.
  const owner = () => ({ headers: { cookie: `${SESSION_COOKIE}=${createSession()}` } });
  const bearer = (t: string) => ({ headers: { authorization: `Bearer ${t}` } });

  before(() => {
    store.append([topic("rust", "technology"), topic("therapy", "health"), topic("raise", "finance")]);
    store.rebuild();
    store.saveProfile({ headline: "h", sections: [], generated_at: "2026-06-12T00:00:00Z", model: "t" });
    setScope("cursor", ["technology"]);
    cursorToken = issueToken("cursor");
    desktopToken = issueToken("claude-desktop");
    server = startDaemon(store, PORT);
  });
  after(() => { server.close(); store.close(); });

  test("/topics filters to the client's allowed categories", async () => {
    const all = await (await fetch(`${BASE}/topics`, owner())).json() as { category: string }[];
    assert.equal(all.length, 3, "the owner sees all");

    const scoped = await (await fetch(`${BASE}/topics`, bearer(cursorToken))).json() as { category: string }[];
    assert.deepEqual(scoped.map((t) => t.category), ["technology"], "cursor sees only technology");

    const open = await (await fetch(`${BASE}/topics`, bearer(desktopToken))).json() as unknown[];
    assert.equal(open.length, 3, "an unscoped client sees all");
  });

  test("/profile is 403 for a scoped client, 200 otherwise", async () => {
    assert.equal((await fetch(`${BASE}/profile`, bearer(cursorToken))).status, 403);
    assert.equal((await fetch(`${BASE}/profile`, bearer(desktopToken))).status, 200);
    assert.equal((await fetch(`${BASE}/profile`, owner())).status, 200);
  });

  test("/scopes reports the config", async () => {
    const scopes = await (await fetch(`${BASE}/scopes`, owner())).json() as Record<string, string[]>;
    assert.deepEqual(scopes.cursor, ["technology"]);
  });

  describe("identity tokens", () => {
    let token: string;
    before(() => {
      token = issueToken("editor-y");
      setScope("editor-y", ["finance"]);
    });

    test("issue / lookup / rotate round-trip", () => {
      assert.equal(hasToken("editor-y"), true);
      assert.equal(hasToken("never-connected"), false);
      assert.equal(clientForToken(token), "editor-y");
      assert.equal(clientForToken("not-a-token"), null);
      const rotated = issueToken("editor-y");
      assert.equal(clientForToken(token), null, "old token dies on rotation");
      assert.equal(clientForToken(rotated), "editor-y");
      token = rotated;
    });

    test("a tokened name without its token is refused", async () => {
      for (const path of ["/topics?client=editor-y", "/profile?client=editor-y", "/search?q=rust&client=editor-y"]) {
        const r = await fetch(`${BASE}${path}`);
        assert.equal(r.status, 401, path);
        const { error } = await r.json() as { error: string };
        assert.match(error, /persnally connect editor-y/, "message says how to fix it");
      }
    });

    test("the token authenticates and the scope still binds", async () => {
      const topics = await (await fetch(`${BASE}/topics?client=editor-y`, bearer(token))).json() as { category: string }[];
      assert.deepEqual(topics.map((t) => t.category), ["finance"], "verified identity, scope enforced");

      const noClaim = await (await fetch(`${BASE}/topics`, bearer(token))).json() as { category: string }[];
      assert.deepEqual(noClaim.map((t) => t.category), ["finance"], "identity comes from the token even without ?client=");
    });

    test("a token cannot claim someone else's name", async () => {
      const r = await fetch(`${BASE}/topics?client=cursor`, bearer(token));
      assert.equal(r.status, 401);
      const { error } = await r.json() as { error: string };
      assert.match(error, /identifies 'editor-y'/);
    });

    test("an unknown token is refused outright", async () => {
      assert.equal((await fetch(`${BASE}/topics`, bearer("stale-after-rotation"))).status, 401);
    });

    test("an untokened name gets no default-open path", async () => {
      // The closed hole: loopback reachability is not a credential, so a name
      // that was never issued a token can't read anything.
      const r = await fetch(`${BASE}/topics?client=never-connected`);
      assert.equal(r.status, 401);
      assert.match((await r.json() as { error: string }).error, /authentication required/);
    });

    test("writes claiming an mcp identity are bound the same way", async () => {
      const event = (client: string) => ({
        type: "context.read", source: `mcp:${client}`,
        payload: { scope: "topics", client_purpose: "", items: 1 },
        provenance: { kind: "mcp", client },
      });
      const post = (body: unknown, init: { headers?: Record<string, string> } = {}) =>
        fetch(`${BASE}/events`, {
          method: "POST", body: JSON.stringify(body),
          headers: { "Content-Type": "application/json", ...init.headers },
        });

      assert.equal((await post([event("editor-y")])).status, 401, "no token, no write");
      assert.equal((await post([event("editor-y")], bearer(token))).status, 201);
      assert.equal((await post([event("cursor")], bearer(token))).status, 401, "can't write as another client");
      assert.equal((await post([event("never-connected")])).status, 401, "an untokened write is refused too");
    });
  });
});
