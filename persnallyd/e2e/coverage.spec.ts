/**
 * The other half of the dashboard: the states dashboard.spec.ts never reaches.
 *   :4994 — EMPTY store, the fresh-install path a new user actually hits
 *   :4993 — RICH store: skills, reflections, a read audit, an answered ask
 *   :4775 — static dist, every view in preview mode
 *
 * Empty and rich are separate daemons because "nothing yet" and "plenty" are
 * different products to render, and the empty one is where unguarded array
 * access surfaces. Console errors fail the test that caused them.
 */

import { ChildProcess, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { expect, Page, test } from "@playwright/test";

const EMPTY = 4994;
const RICH = 4993;
const STATIC = 4775;

let procs: ChildProcess[] = [];
let emptyKey = "";
let richKey = "";

function startSeed(port: number, dir: string, flags: Record<string, string>): Promise<{ proc: ChildProcess; key: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ["e2e/seed-daemon.mjs"], {
      env: { ...process.env, E2E_PORT: String(port), E2E_DIR: dir, ...flags },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    proc.stdout.on("data", (c: Buffer) => {
      out += c.toString();
      const k = /KEY=([A-Za-z0-9_-]+)/.exec(out)?.[1];
      if (k) resolve({ proc, key: k });
    });
    proc.stderr.on("data", (c: Buffer) => { out += c.toString(); });
    proc.on("exit", (code) => reject(new Error(`seed :${port} exited ${code}\n${out}`)));
    setTimeout(() => reject(new Error(`seed :${port} never printed KEY\n${out}`)), 15_000);
  });
}

function trapErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  return errors;
}

async function signIn(page: Page, port: number, k: string) {
  await page.goto(`http://127.0.0.1:${port}/next?k=${k}`);
  await expect(page.locator(".rail-head .wordmark")).toHaveText("persnally");
}

async function openArea(page: Page, area: string) {
  await page.locator(`.rail-item[href="#/${area}"]`).click();
  await expect(page.locator(".topbar .title")).not.toBeEmpty();
}

test.beforeAll(async () => {
  const stamp = Date.now();
  // An empty HOME: the daemon's /import route always reads the real
  // ~/Downloads and ~/.claude, and a test must not depend on (or ingest) the
  // machine's actual history.
  const home = `/tmp/persnally-cov-home-${stamp}`;
  mkdirSync(home, { recursive: true });
  const [e, r] = await Promise.all([
    startSeed(EMPTY, `/tmp/persnally-cov-empty-${stamp}`, { E2E_EMPTY: "1", HOME: home }),
    startSeed(RICH, `/tmp/persnally-cov-rich-${stamp}`, { E2E_RICH: "1", HOME: home }),
  ]);
  emptyKey = e.key;
  richKey = r.key;
  const statik = spawn("python3", ["-m", "http.server", String(STATIC), "--bind", "127.0.0.1", "--directory", "dashboard-ui/dist"], { stdio: "ignore" });
  procs = [e.proc, r.proc, statik];
  await new Promise((res) => setTimeout(res, 800));
});

test.afterAll(() => {
  for (const p of procs) p.kill();
});

test.describe.configure({ mode: "serial" });

// ── the fresh install: every "nothing yet" state, and no crash anywhere ──────

test("a fresh install offers the import that starts the model, not a chat box", async ({ page }) => {
  // With nothing on file the composer could only defer, and a lone text box is
  // indistinguishable from a chat app — the first screen leads with import.
  const errors = trapErrors(page);
  await signIn(page, EMPTY, emptyKey);
  await expect(page.locator(".greeting h1")).toHaveText("Nothing imported yet");
  await expect(page.locator(".greeting-actions .btn")).toHaveText("Import your AI history");
  await expect(page.locator(".ask textarea")).toHaveCount(0);
  await expect(page.locator(".greeting p")).toContainText("nothing leaves this machine");
  expect(errors).toEqual([]);
});

test("an import that finds nothing says so on the first screen too", async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page, EMPTY, emptyKey);
  await page.locator(".greeting-actions .btn").click();
  await expect(page.locator(".greeting .flash")).toContainText("Nothing found to import", { timeout: 90_000 });
});

test("empty store: Data admits every panel is empty, and says how to fill it", async ({ page }) => {
  const errors = trapErrors(page);
  await signIn(page, EMPTY, emptyKey);
  await openArea(page, "data");
  const body = page.locator(".flow-col");
  await expect(body).toContainText("Nothing imported yet.");
  await expect(body).toContainText("No reflections yet");
  await expect(body).toContainText("No skills yet");
  await expect(body).toContainText("No style signals yet.");
  expect(errors).toEqual([]);
});

test("empty store: Access shows no grants, no reads, no asks — without inventing any", async ({ page }) => {
  const errors = trapErrors(page);
  await signIn(page, EMPTY, emptyKey);
  await openArea(page, "access");
  const body = page.locator(".flow-col");
  await expect(body).toContainText("No AI client holds a grant yet");
  await expect(body).toContainText("No reads recorded yet.");
  await expect(body).toContainText("Nothing asked yet.");
  expect(errors).toEqual([]);
});

test("empty store: Connections reports zero events and no importer as imported", async ({ page }) => {
  const errors = trapErrors(page);
  await signIn(page, EMPTY, emptyKey);
  await openArea(page, "connections");
  await expect(page.locator(".row", { hasText: "ChatGPT export" })).toContainText("not imported yet");
  await expect(page.locator(".row", { hasText: "Claude Code sessions" })).toContainText("not imported yet");
  await expect(page.locator(".panel-note").first()).toContainText("0 events on file");
  expect(errors).toEqual([]);
});

test("empty store: Control renders its counts at zero rather than breaking", async ({ page }) => {
  const errors = trapErrors(page);
  await signIn(page, EMPTY, emptyKey);
  await openArea(page, "control");
  await expect(page.locator(".panel", { hasText: "Your data" })).toBeVisible();
  await expect(page.locator(".panel", { hasText: "Your data" })).toContainText("0 events");
  await expect(page.locator(".panel", { hasText: "Models" })).toBeVisible();
  expect(errors).toEqual([]);
});

// ── the panels that need history ────────────────────────────────────────────

test("rich store: skills render with their proficiency and basis", async ({ page }) => {
  const errors = trapErrors(page);
  await signIn(page, RICH, richKey);
  await openArea(page, "data");
  const row = page.locator(".row", { hasText: "TypeScript" });
  await expect(row).toBeVisible();
  await expect(row).toContainText("language");
  expect(errors).toEqual([]);
});

test("rich store: reflections render the assertions the engine derived", async ({ page }) => {
  await signIn(page, RICH, richKey);
  await openArea(page, "data");
  await expect(page.locator(".flow-col")).toContainText("Ships behind a test before calling it done");
  await expect(page.locator(".flow-col")).not.toContainText("No reflections yet");
});

test("rich store: the read audit lists real reads, and the owner's own CLI read is labelled as theirs", async ({ page }) => {
  const errors = trapErrors(page);
  await signIn(page, RICH, richKey);
  await openArea(page, "access");
  const reads = page.locator(".panel", { hasText: "What your AIs read about you" });
  await expect(reads).toContainText("Cursor");
  await expect(reads).toContainText("you · CLI"); // not counted as a grantee client
  await expect(reads.locator(".spark")).toBeVisible();
  await expect(reads.locator(".panel-sub")).toContainText("reads all-time");
  expect(errors).toEqual([]);
});

test("rich store: an ask from a client shows its asker, and 'wrong' records a veto", async ({ page }) => {
  await signIn(page, RICH, richKey);
  await openArea(page, "access");
  const ask = page.locator(".row.col", { hasText: "does he prefer npm or pnpm?" });
  await expect(ask).toBeVisible();
  await expect(ask).toContainText("Cursor"); // asked by the client, not the dashboard
  await ask.getByRole("button", { name: "wrong" }).click();
  await expect(ask.locator(".tag")).toContainText("vetoed");
});

test("rich store: searching for something absent says so instead of showing everything", async ({ page }) => {
  await signIn(page, RICH, richKey);
  await openArea(page, "data");
  await page.locator(".field").first().fill("zzzznotathing");
  await expect(page.locator(".flow-col")).toContainText('Nothing matched "zzzznotathing"');
});

test("rich store: Reflect runs the real consolidation and reports what it found", async ({ page }) => {
  test.setTimeout(240_000); // local model
  const errors = trapErrors(page);
  await signIn(page, RICH, richKey);
  await openArea(page, "control");
  await page.getByRole("button", { name: "Reflect now" }).click();
  await expect(page.locator(".flash")).toBeVisible({ timeout: 210_000 });
  // Either outcome is honest; a silent no-op is not.
  await expect(page.locator(".flash")).toContainText(/signals|assertion|portrait|nothing new|Failed/i);
  expect(errors).toEqual([]);
});

test("Import everything with nothing to import says so — it never claims a false success", async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page, RICH, richKey);
  await openArea(page, "connections");
  await page.getByRole("button", { name: "Import everything" }).click();
  await expect(page.locator(".flash")).toBeVisible({ timeout: 90_000 });
  // Nothing in this HOME, so the only honest answers are "nothing found" or
  // "nothing new" — never a bare "Imported."
  await expect(page.locator(".flash")).toContainText(/Nothing found to import|Nothing new/);
  await expect(page.locator(".panel-note").first()).not.toContainText("0 events on file"); // rich store intact
});

test("rich store: saving a key is accepted and immediately reflected in the engine label", async ({ page }) => {
  // Runs late on purpose: it switches this daemon's engine to Anthropic.
  await signIn(page, RICH, richKey);
  await openArea(page, "connections");
  await page.locator('input[type="password"]').fill("sk-ant-e2e-not-a-real-key");
  await page.getByRole("button", { name: "Save key" }).click();
  await expect(page.locator(".flash")).toContainText("Key saved");
  await expect(page.locator(".panel", { hasText: "Extraction engine" }).locator(".panel-sub").first())
    .toContainText("Claude API");
});

// ── the composer's limits ───────────────────────────────────────────────────

test("the composer caps a very long question instead of sending it whole", async ({ page }) => {
  await signIn(page, RICH, richKey);
  const box = page.locator(".ask textarea");
  await box.fill("x".repeat(900));
  const len = await box.inputValue();
  expect(len.length).toBeLessThanOrEqual(550); // maxlength holds
  await box.fill("");
});

// ── preview mode, every view ────────────────────────────────────────────────

for (const [area, marker] of [
  ["mirror", ".portrait-head h1"],
  ["data", ".rows"],
  ["access", ".rows"],
  ["connections", ".rows"],
  ["control", ".rows"],
] as const) {
  test(`preview mode renders ${area} from fixtures, with the ribbon and no network`, async ({ page }) => {
    const errors = trapErrors(page);
    const requests: string[] = [];
    page.on("request", (r) => {
      const u = r.url();
      if (!u.startsWith(`http://127.0.0.1:${STATIC}/`)) requests.push(u);
    });
    await page.goto(`http://127.0.0.1:${STATIC}/index.html?demo=1#/${area}`);
    await expect(page.locator(".ribbon, .preview-ribbon").first()).toBeVisible();
    await expect(page.locator(marker).first()).toBeVisible();
    // The static host serves only the page; a fixture view must not call an API.
    expect(requests.filter((u) => /\/(stats|profile|topics|events|engine|scopes|activity|questions|voice|skills)/.test(u))).toEqual([]);
    expect(errors).toEqual([]);
  });
}

test("preview mode blocks a destructive control in every view that offers one", async ({ page }) => {
  await page.goto(`http://127.0.0.1:${STATIC}/index.html?demo=1#/data`);
  // Pinned by text: arming swaps the button out, so a `has: button` filter
  // would slide to the next row mid-test.
  const row = page.locator(".row", { hasText: "PostgreSQL query planning" }).first();
  await row.getByRole("button", { name: "forget", exact: true }).click();
  await row.getByRole("button", { name: "forget for good" }).click();
  await expect(page.locator(".flash")).toContainText("Preview mode");
  await expect(row).toBeVisible(); // nothing was destroyed
});

// ── regressions: each of these was a real defect found by audit ─────────────

test("the engine label names the model the daemon actually picked, not Ollama's first tag", async ({ page }) => {
  // Ollama lists tags in its own order; the daemon picks by preference. The
  // dashboard used to print models[0] and name a model nothing ran on.
  await signIn(page, RICH, richKey);
  const engine = await page.request.get(`http://127.0.0.1:${RICH}/engine`).then((r) => r.json()) as {
    hasKey: boolean; ollama: { models: string[] }; models: { extract: string | null; profile: string | null };
  };
  test.skip(!engine.models.extract, "no local engine on this machine");
  await openArea(page, "control");
  // toHaveText retries; textContent() would read before the first poll lands.
  await expect(page.locator(".panel", { hasText: "Models" }).locator(".row", { hasText: "Extraction" }).locator(".row-meta"))
    .toHaveText(engine.models.extract!);
  // and the rail agrees: the model when it's local, the provider when it's the API
  await expect(page.locator(".rail-foot .line2"))
    .toContainText(engine.hasKey ? "Claude API" : engine.models.extract!);
  // never Ollama's first tag when that isn't the pick
  const firstTag = engine.ollama.models[0];
  if (!engine.hasKey && firstTag && firstTag.replace(":latest", "") !== engine.models.extract) {
    await expect(page.locator(".panel", { hasText: "Models" })).not.toContainText(firstTag);
  }
});

test("a restored client stays in the access matrix — it reads everything and must remain revocable", async ({ page }) => {
  await signIn(page, RICH, richKey);
  await openArea(page, "access");
  const grants = page.locator(".panel", { hasText: "What each AI can read" });
  const row = grants.locator(".row.col", { hasText: "Cursor" });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "restore" }).click();
  await expect(page.locator(".flash")).toContainText("reads everything again");
  // The row must survive losing its grant, or the user can never narrow it again.
  await expect(grants.locator(".row.col", { hasText: "Cursor" })).toBeVisible();
  await expect(grants.locator(".row.col", { hasText: "Cursor" })).toContainText("reads everything");
});

test("an unrestricted client's editor shows every category on, not none", async ({ page }) => {
  await signIn(page, RICH, richKey);
  await openArea(page, "access");
  const row = page.locator(".panel", { hasText: "What each AI can read" }).locator(".row.col", { hasText: "Cursor" });
  await expect(row).toContainText("reads everything"); // left unrestricted by the test above
  await row.getByRole("button", { name: "change" }).click();
  const chips = row.locator(".cat");
  const on = row.locator(".cat.on");
  expect(await on.count()).toBe(await chips.count()); // unrestricted = all on
});

test("forgetting something already gone reports that, instead of claiming a delete", async ({ page }) => {
  await signIn(page, RICH, richKey);
  await openArea(page, "data");
  const row = page.locator(".row", { hasText: "disposable topic for deletion test" });
  await row.getByRole("button", { name: "forget", exact: true }).click();
  await row.getByRole("button", { name: "forget for good" }).click();
  await expect(page.locator(".flash")).toContainText("events erased");
  // Delete the same topic again straight through the API: the store is empty of
  // it, so a second UI-visible attempt must not claim success.
  const again = await page.request.fetch(`http://127.0.0.1:${RICH}/topics/${encodeURIComponent("disposable topic for deletion test")}`, { method: "DELETE" });
  expect(again.ok()).toBeTruthy();
  expect((await again.json() as { deleted: number }).deleted).toBe(0);
});

test("reopening a different ask fetches its own evidence, never the previous ask's", async ({ page }) => {
  // Two seeded asks cite different events. The entry component used to be
  // reused across them, so the first ask's cached rows rendered under the
  // second — the same answer shown over someone else's evidence.
  await signIn(page, RICH, richKey);
  const recents = page.locator(".rail-scroll .rail-item");
  await expect(recents).toHaveCount(2);

  await recents.filter({ hasText: "npm or pnpm" }).click();
  await page.locator(".ask-entry").first().getByRole("button", { name: /evidence · 1/ }).click();
  const rows = page.locator(".evidence.open .evidence-row");
  await expect(rows).toHaveCount(1); // retries while the fetch lands
  const first = await rows.allTextContents();

  await recents.filter({ hasText: "ship behind a flag" }).click();
  const button = page.locator(".ask-entry").first().getByRole("button", { name: /evidence · 2/ });
  await expect(button).toBeVisible(); // the count must follow the ask, not the instance
  await button.click();
  await expect(rows).toHaveCount(2);
  expect(await rows.allTextContents()).not.toEqual(first);
});


test("the rail never claims the daemon is unreachable before it has checked", async ({ page }) => {
  // Slow /health down so the pre-answer state is observable.
  await page.route("**/health", async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });
  await page.goto(`http://127.0.0.1:${RICH}/next?k=${richKey}`);
  await expect(page.locator(".rail-foot .line1")).toHaveText("checking…");
  await expect(page.locator(".rail-foot .line1")).toHaveText("daemon running", { timeout: 15_000 });
  await page.unroute("**/health");
});

test("a transient /profile failure keeps the portrait instead of claiming there is none", async ({ page }) => {
  await signIn(page, RICH, richKey);
  await expect(page.locator(".portrait-head h1")).toBeVisible();
  // One failed poll must not rewrite what the user is told about their data.
  await page.route("**/profile", (route) => route.abort());
  await page.waitForTimeout(1200);
  await expect(page.locator(".portrait-head h1")).toBeVisible();
  await expect(page.locator("body")).not.toContainText("No portrait yet");
  await page.unroute("**/profile");
});

test("a preview never writes the real delta baseline", async ({ page }) => {
  await page.goto(`http://127.0.0.1:${STATIC}/index.html?demo=1#/data`);
  await expect(page.locator(".rows").first()).toBeVisible();
  const snap = await page.evaluate(() => localStorage.getItem("persnally.snapshot.v1"));
  expect(snap).toBeNull(); // sample weights would make every real topic look new
});

test("a session-start hook read is attributed to its client, not to you", async ({ page }) => {
  // The highest-volume read channel used to record as `cli`, so the access
  // matrix credited it to nobody and the north-star metric counted every Claude
  // Code session as the owner reading themselves.
  await signIn(page, RICH, richKey);
  await openArea(page, "access");
  const log = page.locator(".panel", { hasText: "What your AIs read about you" });

  const hookRow = log.locator(".row", { hasText: "session-start hook" }).first();
  await expect(hookRow).toBeVisible();
  await expect(hookRow).toContainText("Claude Code");
  await expect(hookRow).not.toContainText("you ·");

  // The owner's own manual read is still labelled as theirs.
  const ownRow = log.locator(".row", { hasText: "manual context read" }).first();
  await expect(ownRow).toContainText("you ·");

  // And the client appears in the grant matrix, where it can be narrowed.
  await expect(page.locator(".panel", { hasText: "What each AI can read" })
    .locator(".row.col", { hasText: "Claude Code" })).toBeVisible();
});
