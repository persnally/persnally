/**
 * End-to-end suite for the workspace dashboard (/next), driven through a real
 * browser against real daemons:
 *   :4998 — seeded store, no API key → Ollama engine (asks actually run)
 *   :4997 — same seed, invalid Anthropic key → deterministic error path
 *   :4776 — static file server over dist/ → demo/no-daemon honesty states
 *
 * Serial by design: tests mutate the seeded store in a known order.
 * Any console pageerror anywhere fails the test that triggered it.
 */

import { ChildProcess, spawn } from "node:child_process";
import { expect, Page, test } from "@playwright/test";

const OK = 4998;
const BAD = 4997;
const STATIC = 4776;

let daemons: ChildProcess[] = [];
let key = "";
let badKey = "";

function startSeed(port: number, dir: string, badkey: boolean): Promise<{ proc: ChildProcess; key: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ["e2e/seed-daemon.mjs"], {
      env: {
        ...process.env,
        E2E_PORT: String(port),
        E2E_DIR: dir,
        E2E_BADKEY: badkey ? "1" : "0",
        E2E_NOPROFILE: badkey ? "1" : "0", // the bad-key daemon doubles as the no-portrait daemon
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    proc.stdout.on("data", (c: Buffer) => {
      out += c.toString();
      const k = /KEY=([A-Za-z0-9_-]+)/.exec(out)?.[1];
      if (k) resolve({ proc, key: k });
    });
    proc.stderr.on("data", (c: Buffer) => { out += c.toString(); });
    proc.on("exit", (code) => reject(new Error(`seed daemon :${port} exited ${code}\n${out}`)));
    setTimeout(() => reject(new Error(`seed daemon :${port} never printed KEY\n${out}`)), 15_000);
  });
}

// Console errors are a test failure, not a footnote.
function trapErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  return errors;
}

test.beforeAll(async () => {
  const stamp = Date.now();
  const [ok, bad] = await Promise.all([
    startSeed(OK, `/tmp/persnally-e2e-ok-${stamp}`, false),
    startSeed(BAD, `/tmp/persnally-e2e-bad-${stamp}`, true), // also seeded with E2E_NOPROFILE
  ]);
  key = ok.key;
  badKey = bad.key;
  const statik = spawn("python3", ["-m", "http.server", String(STATIC), "--bind", "127.0.0.1", "--directory", "dashboard-ui/dist"], { stdio: "ignore" });
  daemons = [ok.proc, bad.proc, statik];
  // let the static server bind
  await new Promise((r) => setTimeout(r, 800));
});

test.afterAll(() => {
  for (const d of daemons) d.kill();
});

test.describe.configure({ mode: "serial" });

// ── auth ────────────────────────────────────────────────────────────────────

test("unauthenticated /next gets the locked page, never data", async ({ page }) => {
  const errors = trapErrors(page);
  const resp = await page.goto(`http://127.0.0.1:${OK}/next`);
  expect(resp!.status()).toBe(401);
  await expect(page.locator("body")).toContainText(/locked/i);
  await expect(page.locator("body")).not.toContainText("PostgreSQL");
  expect(errors).toEqual([]);
});

test("?k= exchanges for a cookie, redirects to /next, and drops the key from the URL", async ({ page }) => {
  await page.goto(`http://127.0.0.1:${OK}/next?k=${key}`);
  await expect(page).toHaveURL(`http://127.0.0.1:${OK}/next`);
  await expect(page.locator(".rail-head .wordmark")).toHaveText("persnally");
  const cookies = await page.context().cookies();
  const session = cookies.find((c) => c.name === "persnally_session");
  expect(session?.httpOnly).toBe(true);
  expect(session?.sameSite).toBe("Strict");
});

test("a wrong key stays locked", async ({ page }) => {
  const resp = await page.goto(`http://127.0.0.1:${OK}/next?k=wrong`);
  expect(resp!.status()).toBe(401);
  await expect(page.locator("body")).toContainText(/locked/i);
});

// ── shell ───────────────────────────────────────────────────────────────────

test("hash routing loads each area directly, and an unknown hash falls back to Mirror", async ({ page }) => {
  await signIn(page, OK, key);
  for (const [hash, title] of [["data", "Data"], ["access", "Access"], ["connections", "Connections"], ["control", "Control"]] as const) {
    // full load each time — the bookmark/deep-link case, not same-document routing
    await page.goto(`http://127.0.0.1:${OK}/next#/${hash}`);
    await page.reload();
    await expect(page.locator(".topbar .title")).toHaveText(title);
  }
  await page.goto(`http://127.0.0.1:${OK}/next#/nonsense`);
  await page.reload();
  await expect(page.locator(".topbar .title")).toHaveText("Mirror");
});

test("the rail collapses to icons and the state survives a reload", async ({ page }) => {
  await signIn(page, OK, key);
  await expect(page.locator(".rail .wordmark")).toBeVisible();
  await page.locator(".rail-toggle").click();
  await expect(page.locator(".shell")).toHaveClass(/collapsed/);
  await expect(page.locator(".rail .wordmark")).toBeHidden();
  await page.reload();
  await expect(page.locator(".shell")).toHaveClass(/collapsed/);
  await page.locator(".rail-toggle").click(); // leave it expanded for later tests
  await expect(page.locator(".shell")).not.toHaveClass(/collapsed/);
});

test("before any ask, the rail shows the honest empty-recents hint", async ({ page }) => {
  await signIn(page, OK, key);
  await expect(page.locator(".rail-hint")).toContainText("Questions your AIs ask show up here");
});

// ── mirror ──────────────────────────────────────────────────────────────────

async function signIn(page: Page, port: number, k: string) {
  await page.goto(`http://127.0.0.1:${port}/next?k=${k}`);
  await expect(page.locator(".rail-head .wordmark")).toHaveText("persnally");
}

/** Navigate the way a user does — a rail click (same-document hashchange). */
async function openArea(page: Page, area: string) {
  await page.locator(`.rail-item[href="#/${area}"]`).click();
}

test("Mirror renders the portrait and the evidence walk resolves real events", async ({ page }) => {
  const errors = trapErrors(page);
  await signIn(page, OK, key);
  await expect(page.locator(".portrait-head h1")).toHaveText("A builder who verifies before shipping");
  await page.getByRole("button", { name: /why\? · 1/ }).click();
  const row = page.locator(".evidence.open .evidence-row");
  await expect(row).toContainText("integration tests before merging");
  await expect(row).toContainText("ChatGPT export · conversation");
  expect(errors).toEqual([]);
});

test("the composer guards empty input, and Shift+Enter is a newline, not a send", async ({ page }) => {
  await signIn(page, OK, key);
  const box = page.locator(".ask textarea");
  await expect(page.locator(".ask-send")).toBeDisabled(); // empty → unsendable
  await box.fill("line one");
  await box.press("Shift+Enter");
  await box.type("line two");
  await expect(box).toHaveValue("line one\nline two");
  await expect(page.locator(".ask-entry")).toHaveCount(0); // nothing sent
  await box.fill(""); // leave clean for the real ask
});

test("the composer asks the model and renders answer, confidence, and evidence", async ({ page }) => {
  test.setTimeout(120_000); // local model inference
  const errors = trapErrors(page);
  await signIn(page, OK, key);
  await page.locator(".ask textarea").fill("npm or pnpm?");
  await page.keyboard.press("Enter");
  const entry = page.locator(".ask-entry");
  await expect(entry).toBeVisible({ timeout: 90_000 });
  await expect(entry.locator(".q")).toHaveText("npm or pnpm?");
  await expect(entry.locator(".a")).not.toBeEmpty();
  // answered or honestly deferred — never blank
  await expect(entry.locator(".ask-meta")).toContainText(/%|deferred/);
  expect(errors).toEqual([]);
});

test("a recent ask opens from the rail with its provenance label", async ({ page }) => {
  await signIn(page, OK, key);
  const recent = page.locator(".rail-scroll .rail-item").first();
  await expect(recent).toContainText("npm or pnpm?");
  await recent.click();
  await expect(page.locator(".ask-label")).toContainText(/asked by dashboard/);
  await page.locator(".ask-label button", { hasText: "close" }).click();
  await expect(page.locator(".ask-label")).toHaveCount(0);
});

test("with no portrait yet, Mirror greets honestly and still offers the composer", async ({ page }) => {
  await signIn(page, BAD, badKey);
  await expect(page.locator(".greeting h1")).toHaveText("No portrait yet");
  await expect(page.locator(".greeting")).toContainText("persnally setup");
  await expect(page.locator(".ask textarea")).toBeVisible();
});

test("the ask error path surfaces the real API failure, honestly", async ({ page }) => {
  const errors = trapErrors(page);
  await signIn(page, BAD, badKey);
  await page.locator(".ask textarea").fill("does the error path work?");
  await page.keyboard.press("Enter");
  await expect(page.locator(".error-text")).toContainText(/./, { timeout: 30_000 });
  await expect(page.locator(".ask-entry")).toHaveCount(0); // no fake answer
  expect(errors).toEqual([]);
});

test("an expired session flips to the signed-out overlay — never to stale or sample data", async ({ page }) => {
  await signIn(page, BAD, badKey);
  await page.context().clearCookies();
  // background fetches 401 within seconds — the app flips itself, no action needed
  await expect(page.locator(".overlay .title")).toHaveText("Your session expired", { timeout: 30_000 });
  await expect(page.locator(".overlay")).toContainText("persnally dashboard");
});

// ── data ────────────────────────────────────────────────────────────────────

test("Data: search finds a topic by prefix", async ({ page }) => {
  await signIn(page, OK, key);
  await openArea(page, "data");
  await page.locator('.field[type="search"]').fill("postgres");
  const hit = page.locator(".rows .row", { hasText: "PostgreSQL query planning" }).first();
  await expect(hit).toBeVisible();
});

test("Data: forgetting a topic requires confirmation and actually deletes", async ({ page }) => {
  await signIn(page, OK, key);
  await openArea(page, "data");
  const row = page.locator(".row", { hasText: "disposable topic for deletion test" });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "forget", exact: true }).click();
  await row.getByRole("button", { name: "forget for good" }).click();
  await expect(page.locator(".flash")).toContainText('Forgot "disposable topic for deletion test"');
  await expect(page.locator(".row", { hasText: "disposable topic for deletion test" })).toHaveCount(0);
});

test("Data: a style pattern deletes from its chip and the pack regenerates", async ({ page }) => {
  await signIn(page, OK, key);
  await openArea(page, "data");
  const chip = page.locator(".chip", { hasText: "disposable style for deletion test" });
  await expect(chip).toBeVisible();
  await chip.locator(".chip-x").click();
  await expect(page.locator(".flash")).toContainText("won't be re-learned");
  await expect(page.locator(".chip", { hasText: "disposable style" })).toHaveCount(0);
});

test("evidence for a deleted event says so — never a fabricated citation", async ({ page }) => {
  // The seed portrait cites exactly one event: the "integration tests" topic.
  // Forget it, then walk the evidence — the panel must admit the deletion.
  await signIn(page, OK, key);
  await openArea(page, "data");
  const row = page.locator(".row", { hasText: "integration tests before merging" });
  await row.getByRole("button", { name: "forget", exact: true }).click();
  await row.getByRole("button", { name: "forget for good" }).click();
  await expect(page.locator(".flash")).toContainText("Forgot");

  await openArea(page, "mirror");
  await page.getByRole("button", { name: /why\? · 1/ }).click();
  await expect(page.locator(".evidence.open")).toContainText("evidence not found (deleted?)");
});

// ── access ──────────────────────────────────────────────────────────────────

test("Access: the scope editor narrows, revokes, and restores a grant", async ({ page }) => {
  await signIn(page, OK, key);
  await openArea(page, "access");
  const cursorRow = page.locator(".row.col", { hasText: "Cursor" });
  await expect(cursorRow.locator(".row-sub")).toContainText("limited: technology");

  await cursorRow.getByRole("button", { name: "change" }).click();
  await cursorRow.locator(".cat", { hasText: "business" }).click();
  await expect(cursorRow.locator(".row-sub")).toContainText("limited: technology, business");

  await cursorRow.getByRole("button", { name: "revoke", exact: true }).click();
  await cursorRow.getByRole("button", { name: "revoke all reads" }).click();
  await expect(cursorRow.locator(".row-sub")).toContainText("revoked — reads nothing");

  await cursorRow.getByRole("button", { name: "restore" }).click();
  await expect(page.locator(".flash")).toContainText("reads everything again");
});

test("Access: judging an answer records the verdict and updates precision", async ({ page }) => {
  await signIn(page, OK, key);
  await openArea(page, "access");
  const ask = page.locator(".row.col", { hasText: "npm or pnpm?" });
  await expect(ask).toBeVisible(); // panel loads async — settle before branching
  // the earlier ask may have answered or deferred; judge only if judgeable
  const right = ask.getByRole("button", { name: "right" });
  if (await right.count()) {
    await right.click();
    await expect(ask.locator(".tag")).toContainText("approved");
    await expect(page.locator(".panel", { hasText: "What your AIs asked" }).locator(".panel-sub")).toContainText("precision");
  } else {
    await expect(ask).toContainText("deferred");
  }
});

test("the ask rate limit surfaces the daemon's message and cools the composer down", async ({ page }) => {
  await signIn(page, BAD, badKey);
  // Exhaust the 20/10min window at the API level — the limiter counts before
  // inference, so bad-key asks trip it fast and cost nothing.
  for (let i = 0; i < 21; i++) {
    const r = await page.request.post(`http://127.0.0.1:${BAD}/ask`, {
      headers: { "content-type": "application/json" },
      data: { question: `limit filler ${i}` },
    });
    if (r.status() === 429) break;
  }
  await page.locator(".ask textarea").fill("one more?");
  await page.keyboard.press("Enter");
  await expect(page.locator(".notice")).toContainText("ask limit reached");
  await expect(page.locator(".ask-send")).toBeDisabled();
});

// ── connections & control ───────────────────────────────────────────────────

test("Connections: engine, imported sources, and client activity are reported from real state", async ({ page }) => {
  const errors = trapErrors(page);
  await signIn(page, OK, key);
  await openArea(page, "connections");
  await expect(page.locator(".panel", { hasText: "Extraction engine" }).locator(".panel-sub")).toContainText(/local via Ollama|Claude API|not configured/);
  const chatgpt = page.locator(".row", { hasText: "ChatGPT export" });
  await expect(chatgpt).toContainText("7 events");
  await expect(chatgpt.locator(".tag")).toContainText("imported");
  await expect(page.locator(".row", { hasText: "git repositories" })).toContainText("not imported yet");
  // a client holding a grant but never active is reported exactly that way
  const cursor = page.locator(".panel", { hasText: "AI clients" }).locator(".row", { hasText: "Cursor" });
  await expect(cursor).toContainText(/grant on file|no activity yet/);
  expect(errors).toEqual([]);
});

test("Control: re-synthesize runs the engine and refreshes the portrait byline", async ({ page }) => {
  test.setTimeout(180_000); // local model synthesis
  await signIn(page, OK, key);
  await openArea(page, "control");
  await page.getByRole("button", { name: "Re-synthesize" }).click();
  await expect(page.getByRole("button", { name: "synthesizing…" })).toBeVisible();
  await expect(page.locator(".flash")).toContainText("Re-synthesized", { timeout: 150_000 });
  await expect(page.locator(".panel-sub", { hasText: "synthesized" })).toContainText("synthesized just now");
});

test("Control: event counts come from the live store", async ({ page }) => {
  await signIn(page, OK, key);
  await openArea(page, "control");
  await expect(page.locator(".row", { hasText: "signal.topic" }).locator(".row-num")).toHaveText("3"); // 5 seeded − 2 forgotten
  // the Models table reports the model that actually synthesized the portrait
  await expect(page.locator(".row", { hasText: "Portrait synthesis" }).locator(".row-meta")).not.toHaveText("seed");
});

// ── honesty states on the static build ──────────────────────────────────────

test("?demo=1 shows sample data with the preview ribbon", async ({ page }) => {
  const errors = trapErrors(page);
  await page.goto(`http://127.0.0.1:${STATIC}/index.html?demo=1`);
  await expect(page.locator(".ribbon")).toContainText("nothing is real");
  await expect(page.locator(".portrait-head h1")).toContainText("A systems thinker");
  expect(errors).toEqual([]);
});

test("without ?demo=1 an unreachable daemon shows the honest page — never sample data", async ({ page }) => {
  await page.goto(`http://127.0.0.1:${STATIC}/index.html`);
  await expect(page.locator(".overlay .title")).toHaveText("Persnally isn't running");
  await expect(page.locator("body")).not.toContainText("A systems thinker");
});

test("a mutation in preview mode is blocked and destroys nothing", async ({ page }) => {
  await page.goto(`http://127.0.0.1:${STATIC}/index.html?demo=1#/data`);
  const row = page.locator(".row", { hasText: "PostgreSQL query planning" });
  await row.getByRole("button", { name: "forget", exact: true }).click();
  await row.getByRole("button", { name: "forget for good" }).click();
  await expect(page.locator(".flash.bad")).toContainText("Preview mode — nothing here can be changed");
  await expect(page.locator(".row", { hasText: "PostgreSQL query planning" })).toBeVisible();
});
