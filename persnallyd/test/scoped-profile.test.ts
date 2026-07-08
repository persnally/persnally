import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { startDaemon } from "../src/daemon.js";
import { newEvent } from "../src/events.js";
import type { LlmExtract } from "../src/llm.js";
import { setScope } from "../src/permissions.js";
import { refreshScopedProfiles, scopeKey, synthesizeScopedProfile } from "../src/profile.js";
import { EventStore } from "../src/store.js";

const PORT = 49866;
const BASE = `http://127.0.0.1:${PORT}`;
const dir = mkdtempSync(join(tmpdir(), "scoped-profile-test-"));
process.env.PERSNALLY_DIR = dir; // scopes live in config — isolate from the real machine
const store = new EventStore(join(dir, "test.db"));
let server: ReturnType<typeof startDaemon>;

const FAKE_PROFILE = { headline: "A tech-only slice", sections: [{ title: "Focus", body: "Builds tools.", evidence_event_ids: [] }] };
const fakeExtract = (calls?: { content: string }): LlmExtract => (async (opts) => {
  if (calls) calls.content = opts.content;
  return FAKE_PROFILE;
}) as LlmExtract;

before(() => {
  store.append([
    newEvent("signal.topic", "import:claude", {
      topic: "typescript daemons", weight: 0.9, intent: "building", sentiment: "positive",
      depth: "deep", category: "technology", entities: ["Node"],
    }, { kind: "import", batch: "b1", file: "conversations.json" }),
    newEvent("signal.topic", "import:claude", {
      topic: "pricing strategy", weight: 0.7, intent: "deciding", sentiment: "neutral",
      depth: "moderate", category: "business", entities: [],
    }, { kind: "import", batch: "b1", file: "conversations.json" }),
    newEvent("signal.assertion", "import:claude", {
      claim: "Runs three products at once", kind: "behavior", confidence: 0.9, evidence: "cross-project chatter",
    }, { kind: "import", batch: "b1", file: "conversations.json" }),
  ]);
  store.rebuild();
  store.saveProfile({ headline: "The full narrative", sections: [{ title: "All", body: "Everything.", evidence_event_ids: [] }], generated_at: new Date().toISOString(), model: "test" });
  server = startDaemon(store, PORT);
});
after(() => { server.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });

test("scopeKey is order-insensitive and deduped", () => {
  assert.equal(scopeKey(["technology", "business"]), "business,technology");
  assert.equal(scopeKey(["business", "technology", "business"]), "business,technology");
});

test("scoped synthesis sees only allowed-category topics — no assertions, no other categories", async () => {
  const calls = { content: "" };
  const p = await synthesizeScopedProfile(store, ["technology"], fakeExtract(calls), "fake");
  assert.ok(p);
  assert.match(calls.content, /typescript daemons/);
  assert.doesNotMatch(calls.content, /pricing strategy/, "business topics must not leak into a technology scope");
  assert.doesNotMatch(calls.content, /Runs three products/, "assertions are cross-category — never in scoped material");
  assert.equal(store.getScopedProfile("technology")?.headline, "A tech-only slice", "cached under the scope key");
});

test("a scope with no topics synthesizes nothing", async () => {
  assert.equal(await synthesizeScopedProfile(store, ["health"], fakeExtract(), "fake"), null);
  assert.equal(store.getScopedProfile("health"), null);
});

test("GET /profile serves the scoped narrative to a scoped client, the full one to everyone else", async () => {
  setScope("cursor", ["technology"]);
  const scoped = await (await fetch(`${BASE}/profile?client=cursor`)).json() as { headline: string };
  assert.equal(scoped.headline, "A tech-only slice");
  const full = await (await fetch(`${BASE}/profile`)).json() as { headline: string };
  assert.equal(full.headline, "The full narrative");
});

test("GET /profile still 403s a scoped client whose scope has no cached profile", async () => {
  setScope("windsurf", ["health", "science"]);
  const r = await fetch(`${BASE}/profile?client=windsurf`);
  assert.equal(r.status, 403);
  assert.equal(((await r.json()) as { scoped: boolean }).scoped, true);
});

test("refreshScopedProfiles rebuilds active scopes and prunes orphans", async () => {
  store.saveScopedProfile("news", { headline: "orphan", sections: [], generated_at: "x", model: "t" });
  const r = await refreshScopedProfiles(store, fakeExtract(), "fake");
  // active scope-sets right now: technology (cursor) + health,science (windsurf — no topics → not refreshed)
  assert.equal(r.refreshed, 1);
  assert.ok(r.pruned >= 1, "cached sets no client uses anymore are deleted");
  assert.equal(store.getScopedProfile("news"), null);
  assert.ok(store.getScopedProfile("technology"));
});

test("forgetAll wipes scoped profiles too", () => {
  assert.ok(store.scopedProfileKeys().length > 0);
  store.forgetAll();
  assert.equal(store.scopedProfileKeys().length, 0);
  assert.equal(store.getProfile(), null);
});
