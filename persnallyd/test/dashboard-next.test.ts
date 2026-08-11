/**
 * The workspace dashboard's honesty invariants — successors of
 * dashboard.test.ts, pointed at the SPA source and its built artifact.
 * The claims under test: a real user never sees fabricated data, demo is
 * opt-in via ?demo=1 only, a 401 is signed-out (never demo), and the built
 * page stays self-contained.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

// Compiled test runs from build/test/ — the repo root is two levels up.
// fileURLToPath, not .pathname: pathname keeps %20 and breaks Windows drives.
const root = fileURLToPath(new URL("../../", import.meta.url));
const ui = (p: string) => readFileSync(join(root, "dashboard-ui/src", p), "utf-8");

describe("boot-state: the trust logic", () => {
  const src = ui("lib/boot-state.ts");

  test("demo mode is opt-in via the query string, nothing else", () => {
    assert.match(src, /const PREVIEW = new URLSearchParams\(location\.search\)\.has\("demo"\)/);
  });

  test("401 outranks demo, and the no-daemon gate precedes any demo return", () => {
    const signedOut = src.indexOf('if (unauthorized) return "signed-out"');
    const noDaemon = src.indexOf('if (!PREVIEW) return "no-daemon"');
    const demo = src.indexOf('return "demo"');
    assert.ok(signedOut !== -1, "signed-out branch exists");
    assert.ok(noDaemon !== -1, "no-daemon gate exists");
    assert.ok(demo !== -1, "demo branch exists");
    assert.ok(signedOut < noDaemon, "a 401 must resolve before the daemon-down branches");
    assert.ok(noDaemon < demo, "the honest no-daemon page must gate the demo branch");
  });
});

describe("fixtures have exactly one door", () => {
  test("fixtures/demo is imported only by the API client factory", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) {
          walk(p);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(name)) continue;
        if (!readFileSync(p, "utf-8").includes("fixtures/demo")) continue;
        const rel = p.slice(join(root, "dashboard-ui/src").length + 1);
        if (rel !== "api/client.ts" && !rel.startsWith("fixtures/")) offenders.push(rel);
      }
    };
    walk(join(root, "dashboard-ui/src"));
    assert.deepEqual(offenders, [], "sample data must flow only through the demo client");
  });
});

describe("the poll stops when the page isn't live", () => {
  test("use-poll gates every tick on boot state and visibility", () => {
    assert.match(ui("lib/use-poll.ts"), /if \(boot !== "live" \|\| document\.hidden\) return/);
  });
});

describe("the built artifact", () => {
  const artifact = readFileSync(join(root, "build/src/dashboard-next.html"), "utf-8");

  test("carries the honest-state copy through minification", () => {
    for (const literal of ["Persnally isn", "persnally start", "Your data is still on this", "Your session expired", "persnally dashboard"]) {
      assert.ok(artifact.includes(literal), `artifact must contain "${literal}"`);
    }
  });

  test("is self-contained — no external scripts, styles, or images", () => {
    assert.doesNotMatch(artifact, /<script[^>]+src=/);
    assert.doesNotMatch(artifact, /<link[^>]+rel="stylesheet"[^>]+href="http/);
    assert.doesNotMatch(artifact, /<img[^>]+src="http/);
  });

  test("stays under the size guard", () => {
    assert.ok(artifact.length < 400_000, `artifact is ${artifact.length} bytes; the single-file build must stay lean`);
  });
});
