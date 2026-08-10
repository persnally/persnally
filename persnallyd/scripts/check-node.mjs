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

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8"));
const required = Number(pkg.engines.node.replace(/[^\d]/g, ""));
const current = Number(process.versions.node.split(".")[0]);

if (current >= required) process.exit(0);

/**
 * A supported Node already installed under nvm, if there is one. Worth finding:
 * the failure is rarely "Node 22 is missing", it is a shell that resolved
 * something else — and in the incident that prompted this, nvm was not even
 * loaded in the shell running the publish, so `nvm use` alone was no help.
 */
function installedPath() {
  const root = join(homedir(), ".nvm", "versions", "node");
  if (!existsSync(root)) return null;
  const match = readdirSync(root)
    .filter((v) => v.startsWith(`v${required}.`))
    .sort()
    .pop();
  return match ? join(root, match, "bin") : null;
}

const bin = installedPath();

console.error(
  `\npersnally needs Node >=${required} to build. This is ${process.version} (${process.execPath}).\n\n` +
    `On older Node the SQLite binding fails to load and the tests fail in ways that\n` +
    `look unrelated — a segfault and "is not a function" everywhere.\n\n` +
    (bin
      ? `  nvm use ${required}\n  # or, if nvm is not loaded in this shell:\n  export PATH="${bin}:$PATH"\n`
      : `  nvm install ${required} && nvm use ${required}\n`),
);
process.exit(1);
