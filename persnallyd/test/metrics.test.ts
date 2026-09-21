/**
 * The ping is the one thing Persnally sends on its own behalf, so what it may
 * carry and when it may go are asserted here rather than left to review.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import { loadConfig, saveConfig } from "../src/config.js";
import {
  disableMetrics, disclosure, enableMetrics, metricsState, PING_URL, pingPayload, pingsPending, reachedStages, sendPendingPings, type Ping,
} from "../src/metrics.js";
import type { Activity } from "../src/store.js";

const dir = mkdtempSync(join(tmpdir(), "persnally-metrics-"));
process.env.PERSNALLY_DIR = dir;
after(() => {
  delete process.env.PERSNALLY_DIR;
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => rmSync(join(dir, "config.json"), { force: true }));

const activity = (over: Partial<Activity> = {}): Activity => ({
  firstEventAt: "2026-09-01T10:00:00Z", firstReadAt: null, lastReadAt: null,
  daysSinceFirst: 0, daysSinceFirstRead: 0, totalReads: 0, reads7d: 0, reads30d: 0,
  activeDays7d: 0, activeDays14d: 0, retainedWeek2: null, daily: [], ...over,
});
const retained = activity({
  firstReadAt: "2026-09-01T10:05:00Z", lastReadAt: "2026-09-20T09:00:00Z", totalReads: 40, retainedWeek2: true,
});

describe("stages follow the funnel", () => {
  test("no AI read yet is installed and nothing more", () => {
    assert.deepEqual(reachedStages(activity()), ["installed"]);
  });
  test("reads on the first day only are activated, not returned", () => {
    const a = activity({ firstReadAt: "2026-09-01T10:05:00Z", lastReadAt: "2026-09-01T23:50:00Z" });
    assert.deepEqual(reachedStages(a), ["installed", "activated"]);
  });
  test("a read on a later day is returned; week 2 needs the window to have closed as retained", () => {
    const a = activity({ firstReadAt: "2026-09-01T10:05:00Z", lastReadAt: "2026-09-02T00:10:00Z" });
    assert.deepEqual(reachedStages(a), ["installed", "activated", "returned"]);
    assert.deepEqual(reachedStages({ ...a, retainedWeek2: false }), ["installed", "activated", "returned"]);
    assert.deepEqual(reachedStages(retained), ["installed", "activated", "returned", "week2"]);
  });
});

describe("nothing is sent without a yes", () => {
  test("a fresh install is off and unasked, and sends nothing", async () => {
    assert.deepEqual(metricsState(), { state: null, asked: false });
    assert.equal(pingsPending(), false);
    const posted: Ping[] = [];
    assert.deepEqual(await sendPendingPings(retained, "3.3.0", async (p) => { posted.push(p); return true; }), []);
    assert.equal(posted.length, 0);
  });
  test("a no is remembered, so setup does not ask twice", () => {
    disableMetrics();
    assert.deepEqual(metricsState(), { state: null, asked: true });
  });
  test("turning it off discards the id — on again is a new install", () => {
    const first = enableMetrics().id;
    assert.equal(enableMetrics().id, first, "on twice must not rotate the id");
    disableMetrics();
    assert.notEqual(enableMetrics().id, first);
  });
});

describe("what is sent", () => {
  test("the payload is exactly id, stage and version", () => {
    assert.deepEqual(Object.keys(pingPayload("x", "installed", "3.3.0")).sort(), ["id", "stage", "v"]);
  });
  test("the disclosure shows the literal payload and the real destination", () => {
    const text = disclosure("3.3.0", "abc");
    assert.ok(text.includes(JSON.stringify(pingPayload("abc", "activated", "3.3.0"))));
    assert.equal(PING_URL, "https://persnally.com/api/ping");
    assert.ok(text.split(/\s+/).includes(`${PING_URL}:`), "the destination must appear verbatim");
  });
  test("each reached stage goes once, in order, and is never repeated", async () => {
    const { id } = enableMetrics();
    const posted: Ping[] = [];
    const post = async (p: Ping) => { posted.push(p); return true; };
    assert.deepEqual(await sendPendingPings(retained, "3.3.0", post), ["installed", "activated", "returned", "week2"]);
    assert.deepEqual(await sendPendingPings(retained, "3.3.0", post), []);
    assert.deepEqual(posted.map((p) => p.stage), ["installed", "activated", "returned", "week2"]);
    assert.equal(pingsPending(), false, "a finished funnel must stop costing the daemon a query");
    assert.ok(posted.every((p) => p.id === id && p.v === "3.3.0"));
  });
});

describe("failure is quiet and retried", () => {
  test("a rejected or thrown send records nothing, and the next tick sends it", async () => {
    enableMetrics();
    assert.deepEqual(await sendPendingPings(retained, "3.3.0", async () => false), []);
    assert.deepEqual(await sendPendingPings(retained, "3.3.0", async () => { throw new Error("offline"); }), []);
    assert.deepEqual(metricsState().state?.sent, []);
    assert.equal((await sendPendingPings(retained, "3.3.0", async () => true)).length, 4);
  });
  test("turning it off mid-flight is not undone by the send that was in the air", async () => {
    enableMetrics();
    await sendPendingPings(retained, "3.3.0", async () => { disableMetrics(); return true; });
    assert.deepEqual(metricsState(), { state: null, asked: true });
  });
  test("an opted-in config keeps the rest of the config intact", async () => {
    saveConfig({ anthropic_api_key: "sk-ant-test" });
    enableMetrics();
    await sendPendingPings(activity(), "3.3.0", async () => true);
    assert.equal(loadConfig().anthropic_api_key, "sk-ant-test");
  });
});
