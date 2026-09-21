/**
 * A global install made under Node 22 and run under an older Node on the same
 * machine segfaults inside the SQLite binding, and the SessionStart hook hides
 * it. The gate turns that into one line on stderr — as long as it is what runs
 * first, and what it demands is what the package declares.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { REQUIRED_NODE_MAJOR } from "../src/node-gate.js";

const src = (file: string) => readFileSync(new URL(`../../src/${file}`, import.meta.url), "utf-8");

test("the gate demands the major the package declares in engines", () => {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf-8")) as { engines: { node: string } };
  assert.equal(pkg.engines.node, `>=${REQUIRED_NODE_MAJOR}`);
});

test("the CLI evaluates the gate before any module that can reach the store", () => {
  const firstImport = src("cli.ts").split("\n").find((l) => l.startsWith("import "));
  assert.equal(firstImport, 'import "./node-gate.js";');
});
