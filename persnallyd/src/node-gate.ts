/**
 * Refuse to run on a Node the SQLite binding was not built for.
 *
 * `engines` only warns at install time, and a machine with two Nodes (a global
 * install made under nvm's 22, a Homebrew or /usr/local 20 first on PATH) gets
 * the 22 prebuild loaded into 20: a segfault on the first query, which the
 * SessionStart hook discards along with everything else on stderr. Imported
 * first, before any module that reaches the store, so the message is the only
 * thing that happens.
 */

export const REQUIRED_NODE_MAJOR = 22;

const major = Number(process.versions.node.split(".")[0]);
if (major < REQUIRED_NODE_MAJOR) {
  process.stderr.write(
    `persnally needs Node >=${REQUIRED_NODE_MAJOR}; this is ${process.version} (${process.execPath}).\n`,
  );
  process.exit(1);
}
