/**
 * End-to-end suite for the dashboard, driven through a real
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

test("unauthenticated / gets the locked page, never data", async ({ page }) => {
  const errors = trapErrors(page);
  const resp = await page.goto(`http://127.0.0.1:${OK}/`);
  expect(resp!.status()).toBe(401);
  await expect(page.locator("body")).toContainText(/locked/i);
  await expect(page.locator("body")).not.toContainText("PostgreSQL");
  expect(errors).toEqual([]);
});

test("?k= exchanges for a cookie, redirects to /, and drops the key from the URL", async ({ page }) => {
  await page.goto(`http://127.0.0.1:${OK}/?k=${key}`);
  await expect(page).toHaveURL(`http://127.0.0.1:${OK}/`);
  await expect(page.locator(".rail-head .wordmark")).toHaveText("persnally");
  const cookies = await page.context().cookies();
  const session = cookies.find((c) => c.name === "persnally_session");
  expect(session?.httpOnly).toBe(true);
  expect(session?.sameSite).toBe("Strict");
});

test("a wrong key stays locked", async ({ page }) => {
  const resp = await page.goto(`http://127.0.0.1:${OK}/?k=wrong`);
  expect(resp!.status()).toBe(401);
  await expect(page.locator("body")).toContainText(/locked/i);
});

// ── shell ───────────────────────────────────────────────────────────────────

test("hash routing loads each area directly, and an unknown hash falls back to Answers", async ({ page }) => {
  await signIn(page, OK, key);
  for (const [hash, title] of [["mirror", "Mirror"], ["data", "Data"], ["access", "Access"], ["connections", "Connections"], ["control", "Control"]] as const) {
    // full load each time — the bookmark/deep-link case, not same-document routing
    await page.goto(`http://127.0.0.1:${OK}/#/${hash}`);
    await page.reload();
    await expect(page.locator(".topbar .title")).toHaveText(title);
  }
  await page.goto(`http://127.0.0.1:${OK}/#/nonsense`);
  await page.reload();
  await expect(page.locator(".topbar .title")).toHaveText("Answers");
});

test("collapsing hides the rail completely, and the state survives a reload", async ({ page }) => {
  await signIn(page, OK, key);
  await expect(page.locator(".rail .wordmark")).toBeVisible();
  await page.locator(".rail-toggle").click();
  await page.mouse.move(900, 400); // off the edge zone, or it peeks straight back
  await expect(page.locator(".shell")).toHaveClass(/collapsed/);
  await settleRail(page);

  // Gone from the layout, not merely narrowed — the canvas takes the width.
  const rail = (await page.locator(".rail").boundingBox())!;
  const canvas = (await page.locator(".canvas").boundingBox())!;
  expect(rail.x + rail.width).toBeLessThanOrEqual(0);
  expect(canvas.x).toBe(0);
  await expect(page.locator(".topbar-toggle")).toBeVisible();

  await page.reload();
  await page.mouse.move(900, 400);
  await expect(page.locator(".shell")).toHaveClass(/collapsed/);

  // The top bar's toggle is the way back.
  await page.locator(".topbar-toggle").click();
  await expect(page.locator(".shell")).not.toHaveClass(/collapsed/);
  await expect(page.locator(".rail .wordmark")).toBeVisible();
});

test("hovering the left edge peeks the hidden rail over the canvas, without reflowing it", async ({ page }) => {
  await signIn(page, OK, key);
  await page.locator(".rail-toggle").click();
  await page.mouse.move(900, 400);
  await settleRail(page);
  const canvasBefore = (await page.locator(".canvas").boundingBox())!;

  await page.mouse.move(5, 400); // the edge hit zone
  await settleRail(page);
  const peeked = (await page.locator(".rail").boundingBox())!;
  expect(peeked.x).toBe(0);
  expect(peeked.width).toBeGreaterThan(200);
  await expect(page.locator(".rail .wordmark")).toBeVisible();
  // It floats: the content underneath must not move.
  expect((await page.locator(".canvas").boundingBox())!.x).toBe(canvasBefore.x);

  // Moving into the rail keeps it open rather than snapping it shut.
  await page.mouse.move(120, 400);
  await settleRail(page);
  expect((await page.locator(".rail").boundingBox())!.x).toBe(0);

  await page.mouse.move(900, 400);
  await settleRail(page);
  expect((await page.locator(".rail").boundingBox())!.x).toBeLessThan(0);

  await page.locator(".topbar-toggle").click(); // restore for later tests
  await expect(page.locator(".shell")).not.toHaveClass(/collapsed/);
});

test("every rail glyph is drawn on the same optical grid", async ({ page }) => {
  // A set where one glyph spans 10 units and another 19 reads as broken even
  // though both are nominally 16px.
  await signIn(page, OK, key);
  const boxes = await page.locator(".rail-nav .glyph svg").evaluateAll((els) =>
    els.map((el) => {
      const b = (el as SVGGraphicsElement).getBBox();
      return { w: +b.width.toFixed(1), h: +b.height.toFixed(1) };
    }),
  );
  expect(boxes.length).toBe(6);
  for (const b of boxes) {
    // Every glyph fills its box on at least one axis, and none overflows it.
    expect(Math.max(b.w, b.h)).toBeGreaterThanOrEqual(14);
    expect(Math.max(b.w, b.h)).toBeLessThanOrEqual(19.5);
  }
  const widths = boxes.map((b) => Math.max(b.w, b.h));
  expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(4);
});


test("before any ask, the ledger says so — and offers no text box", async ({ page }) => {
  await signIn(page, OK, key);
  await expect(page.locator(".ledger-num")).toHaveText("0");
  await expect(page.locator(".ask-entry")).toHaveCount(0);
  await expect(page.locator("textarea")).toHaveCount(0);
});

// ── mirror ──────────────────────────────────────────────────────────────────

async function signIn(page: Page, port: number, k: string) {
  await page.goto(`http://127.0.0.1:${port}/?k=${k}`);
  await expect(page.locator(".rail-head .wordmark")).toHaveText("persnally");
}

/** Wait for the rail to stop moving, rather than sampling a frame mid-flight.
    Position matters as much as width — hiding animates `transform`, so a
    width-only check would pass while the rail is still sliding. */
async function settleRail(page: Page) {
  let last = "";
  await expect.poll(async () => {
    const b = (await page.locator(".rail").boundingBox())!;
    const now = `${b.x.toFixed(1)}x${b.width.toFixed(1)}`;
    const stable = now === last;
    last = now;
    return stable;
  }, { timeout: 5000 }).toBe(true);
}

/** Navigate the way a user does — a rail click (same-document hashchange). */
async function openArea(page: Page, area: string) {
  await page.locator(`.rail-item[href="#/${area}"]`).click();
}

test("Mirror renders the portrait and the evidence walk resolves real events", async ({ page }) => {
  const errors = trapErrors(page);
  await signIn(page, OK, key);
  await openArea(page, "mirror");
  await expect(page.locator(".portrait-head h1")).toHaveText("A builder who verifies before shipping");
  await page.getByRole("button", { name: /why\? · 1/ }).click();
  const row = page.locator(".evidence.open .evidence-row");
  await expect(row).toContainText("integration tests before merging");
  await expect(row).toContainText("ChatGPT export · conversation");
  expect(errors).toEqual([]);
});

test("an ask made over the API lands on the ledger with its answer and confidence", async ({ page }) => {
  test.setTimeout(120_000); // local model inference
  const errors = trapErrors(page);
  await signIn(page, OK, key);
  const r = await page.request.post(`http://127.0.0.1:${OK}/ask`, {
    headers: { "content-type": "application/json" },
    data: { question: "npm or pnpm?" },
    timeout: 90_000,
  });
  expect(r.ok()).toBeTruthy();
  const entry = page.locator(".ask-entry", { hasText: "npm or pnpm?" });
  await expect(entry).toBeVisible({ timeout: 40_000 }); // the next poll tick
  await expect(entry.locator(".a")).not.toBeEmpty();
  // answered or honestly sent back — never blank
  await expect(entry.locator(".ask-meta")).toContainText(/%/);
  expect(errors).toEqual([]);
});

test("with data but no portrait, Mirror offers the synthesis rather than a CLI command", async ({ page }) => {
  // Distinct from a fresh install: there is evidence on file, so asking works
  // and the missing step is synthesis — offered as a button, not as prose.
  await signIn(page, BAD, badKey);
  await openArea(page, "mirror");
  await expect(page.locator(".greeting h1")).toHaveText("No portrait yet");
  await expect(page.locator(".greeting")).toContainText("events on file");
  await expect(page.locator(".greeting-actions .btn")).toHaveText("Synthesize the portrait");
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

test("judging an answer on the ledger records the verdict and updates the count", async ({ page }) => {
  await signIn(page, OK, key);
  const ask = page.locator(".ask-entry", { hasText: "npm or pnpm?" });
  await expect(ask).toBeVisible(); // loads async — settle before branching
  // the earlier ask may have answered or been sent back; judge only if judgeable
  const right = ask.getByRole("button", { name: "right", exact: true });
  if (await right.count()) {
    await right.click();
    await expect(ask.locator(".tag")).toContainText("approved");
    await expect(page.locator(".ledger-sub")).toContainText("1 of 1 judged marked right");
  } else {
    await expect(ask).toContainText("sent back");
  }
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
  await expect(page.locator(".ledger-num")).toHaveText("2");
  await openArea(page, "mirror");
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

test("a key that fails every call is reported as failing, not as a healthy engine", async ({ page }) => {
  // The BAD daemon holds an invalid key. One synthesis forces a real API
  // rejection, so the daemon has an
  // outage on record — a configured key that never works used to render as
  // "Claude API" with a green dot.
  await signIn(page, BAD, badKey);
  const r = await page.request.post(`http://127.0.0.1:${BAD}/synthesize`, { timeout: 30_000 });
  expect(r.ok()).toBeFalsy(); // no fake portrait
  await page.reload(); // the rail reads engine health at boot, then on its own poll
  await openArea(page, "connections");
  const engine = page.locator(".panel", { hasText: "Extraction engine" });
  await expect(engine.locator(".flash.bad")).toContainText("The engine is failing");
  await expect(engine.locator(".flash.bad")).toContainText("Nothing new is being extracted");
  await expect(page.locator(".rail-foot .line2")).toContainText("failing");
});

test("a ledger row says who asked — here, the owner's own session", async ({ page }) => {
  // Provenance at a glance (a client's ask is covered on the rich store).
  // A generic chat bubble said neither.
  await signIn(page, OK, key);
  await expect(page.locator(".ask-entry", { hasText: "npm or pnpm?" }).first().locator(".ask-label")).toContainText("dashboard asked");
});
