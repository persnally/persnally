import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/**
 * Structural guards, not behaviour.
 *
 * Context serving used to be implemented twice — once in the CLI hook, once in
 * the MCP tool — and they drifted until each served something the other didn't.
 * Recording was duplicated per channel, each inventing its own `source`, which
 * is how a hook read came to be credited to the owner instead of the client it
 * was injected into (#129).
 *
 * A test that only checks behaviour would let the next channel reintroduce both.
 * These fail if a second renderer or a second writer appears at all.
 */

const src = fileURLToPath(new URL("../../src/", import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith(".ts") ? [full] : [];
  });
}

const files = walk(src).map((f) => ({ path: f.slice(src.length), text: readFileSync(f, "utf-8") }));

test("only context-pack.ts renders a context pack for a model", () => {
  // The section headings are the fingerprint of an assembled pack.
  const renderers = files.filter((f) => /# About the user|# Current interests \(decay/.test(f.text));
  assert.deepEqual(renderers.map((f) => f.path), ["context-pack.ts"],
    "a second renderer appeared — the two will drift, as they did before");
});

test("only context-pack.ts writes a context.read event", () => {
  const writers = files.filter((f) => /newEvent\(\s*"context\.read"/.test(f.text));
  assert.deepEqual(writers.map((f) => f.path), ["context-pack.ts"],
    "a channel is constructing its own read event, so it can invent its own attribution");
});

test("the MCP server never constructs a read event — the daemon attributes it", () => {
  // It runs in a separate process and posts over HTTP; if it builds the event
  // it also chooses `source`, which means a client naming itself.
  const mcp = files.filter((f) => f.path.startsWith("mcp/"));
  assert.ok(mcp.length > 0, "no MCP sources found — the guard would pass vacuously");
  for (const f of mcp) {
    assert.doesNotMatch(f.text, /"context\.read"/,
      `${f.path} references context.read directly; declare it via POST /reads instead`);
  }
});

test("every read surface is spelled the same way in one place", () => {
  const pack = files.find((f) => f.path === "context-pack.ts");
  assert.ok(pack, "context-pack.ts is missing");
  // The union is declared once; a channel cannot invent a fifth spelling.
  assert.match(pack.text, /export type ReadSurface = "mcp" \| "hook" \| "cli" \| "dashboard";/);
});

test("every renderer that takes a grant refuses a revoked one", () => {
  // `allowed: []` is revoked. Gating only the category-tagged sections on it
  // served writing style and project conventions to a client the dashboard had
  // promised reads nothing — in both renderers, because each route was expected
  // to remember its own check and two of them did not.
  for (const path of ["context-pack.ts", "ask.ts"]) {
    const f = files.find((x) => x.path === path);
    assert.ok(f, `${path} is missing`);
    assert.match(f.text, /readsNothing\(allowed\)/,
      `${path} assembles context without refusing a revoked grant first`);
  }
});
