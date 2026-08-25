/**
 * `persnally import codex --reextract` (no path, the common case for an
 * optional-path source) used to resolve `path` to the literal string
 * "--reextract" — `const [kind, path] = args` takes whatever is at index 1,
 * flag or not. The importer then tried to read a directory named
 * "--reextract" and failed with a confusing error instead of falling back to
 * its default. Caught by review on PR #242; pre-existed identically for
 * claude-code and cursor, fixed once at the shared parsing site.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseImportArgs } from "../src/cli.js";

test("--reextract alone is not mistaken for the path", () => {
  const r = parseImportArgs(["codex", "--reextract"]);
  assert.equal(r.kind, "codex");
  assert.equal(r.path, undefined, "no path given -> the importer's own default, not the flag");
  assert.equal(r.reextract, true);
});

test("a real path alongside --reextract still resolves, in either order", () => {
  assert.deepEqual(parseImportArgs(["codex", "/some/dir", "--reextract"]),
    { kind: "codex", path: "/some/dir", reextract: true });
  assert.deepEqual(parseImportArgs(["codex", "--reextract", "/some/dir"]),
    { kind: "codex", path: "/some/dir", reextract: true });
});

test("a required-path source (claude, chatgpt) still gets its path with no --reextract", () => {
  const r = parseImportArgs(["claude", "/some/dir"]);
  assert.equal(r.path, "/some/dir");
  assert.equal(r.reextract, false);
});

test("git's --author value is not mistaken for the path either", () => {
  const r = parseImportArgs(["git", "/some/repos", "--author", "me@example.com"]);
  assert.equal(r.path, "/some/repos", "the first non-flag positional, not --author's own value");
});

test("no arguments at all", () => {
  assert.deepEqual(parseImportArgs([]), { kind: undefined, path: undefined, reextract: false });
});
