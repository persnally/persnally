/**
 * Refuse to build or publish on a Node the package does not support.
 *
 * `engines` only warns, and `engine-strict` covers `npm install` — not the
 * lifecycle scripts a publish runs. Without this, publishing from Node 20 fails
 * as a segfault plus dozens of "is not a function" errors: the native SQLite
 * binding cannot initialise, so every module that transitively imports the store
 * ends up with undefined exports. Nothing in that output names the real cause,
 * and a release was lost to it once.
 */

import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8"));
const required = Number(pkg.engines.node.replace(/[^\d]/g, ""));
const current = Number(process.versions.node.split(".")[0]);

if (current < required) {
  console.error(
    `\npersnally needs Node >=${required} to build. This is ${process.version}` +
      (process.execPath ? ` (${process.execPath})` : "") +
      `.\n\nOn older Node the SQLite binding fails to load and the tests fail in ways` +
      `\nthat look unrelated — a segfault and "is not a function" everywhere.\n\n` +
      `  nvm use ${required}\n` +
      `  # or: export PATH="$HOME/.nvm/versions/node/v${required}.19.0/bin:$PATH"\n`,
  );
  process.exit(1);
}
