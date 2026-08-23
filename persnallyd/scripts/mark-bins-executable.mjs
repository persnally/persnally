/**
 * Give the `bin` entries their executable bit.
 *
 * `tsc` emits 0644, and the shebang at the top of cli.js is useless without the
 * bit — the shell refuses before node is ever consulted. A registry install
 * hides this, because npm sets the bit on bin targets itself, so it only bites
 * the paths that matter most to us: `npm link`, a global install pointed at a
 * checkout, and anyone running the repo directly. On this machine it meant the
 * `persnally` command was simply "permission denied".
 */

import { chmodSync, existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("package.json", root)), "utf-8"));

for (const target of new Set(Object.values(pkg.bin ?? {}))) {
  const path = fileURLToPath(new URL(target, root));
  if (!existsSync(path)) {
    console.error(`mark-bins-executable: ${target} is missing — did the build run?`);
    process.exit(1);
  }
  // Preserve the rest of the mode; grant execute wherever read is already granted.
  const mode = statSync(path).mode & 0o777;
  chmodSync(path, mode | ((mode & 0o444) >> 2));
}
