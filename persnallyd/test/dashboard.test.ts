/**
 * The dashboard is a single self-contained HTML file with no DOM harness in
 * this repo, so these are source invariants rather than rendering tests. They
 * are here because the property they guard is a trust claim, not a layout
 * detail: sample data is a portrait of a person who does not exist, and it must
 * never appear except when explicitly asked for.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

const html = readFileSync(new URL("../../src/dashboard.html", import.meta.url), "utf-8");
const page = readFileSync(new URL("../../../web/src/app/page.tsx", import.meta.url), "utf-8");

describe("sample data is opt-in", () => {
  test("the demo flag is read from the query string, not assumed", () => {
    assert.match(html, /const PREVIEW = new URLSearchParams\(location\.search\)\.has\("demo"\)/);
  });

  test("the daemon-down branch bails to an honest state before touching sample data", () => {
    const gate = html.indexOf("if (!PREVIEW) return renderNoDaemon();");
    const useSample = html.indexOf("= DEMO_DATA()");
    assert.ok(gate > 0, "the preview gate must exist in the failure branch");
    assert.ok(useSample > gate, "sample data must only be reachable after that gate");
  });

  test("the honest state names the real situation and the fix", () => {
    // The apostrophe is backslash-escaped inside the single-quoted JS string.
    assert.match(html, /Persnally isn\\?'t running/);
    assert.match(html, /persnally start/);
    // The user's data still exists — the daemon serving it is what's down.
    // (The sentence is split across source lines by the string concatenation.)
    assert.match(html, /Your data is still on this/);
  });

  test("polling stops once the daemon is known to be down", () => {
    assert.match(html, /if \(DEMO \|\| SIGNED_OUT \|\| DAEMON_DOWN\) return;/);
  });
});

describe("the marketing preview opts itself in", () => {
  test("the site's iframe asks for demo data explicitly", () => {
    assert.match(page, /src="\/dashboard-preview\.html\?demo=1"/,
      "otherwise the published preview renders the daemon-down state instead of the demo");
  });
});
