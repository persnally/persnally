/**
 * The git importer is the only key-free path — it needs no model and no export,
 * so for a developer with no API key it is the entire product. It read commit
 * *dates* and nothing else, which meant one topic per repo: its directory name.
 * Subjects and touched paths are the user's own record of their own work, and
 * mining them stays fully deterministic and offline.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { gitEvents, languagesFromPaths, summarizeRepo, themesFromSubjects } from "../src/importers/git.js";

const tmp = mkdtempSync(join(tmpdir(), "git-depth-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

describe("themes from commit subjects", () => {
  test("conventional-commit scopes are read as the areas worked on", () => {
    const themes = themesFromSubjects([
      "feat(import): add the chatgpt parser",
      "fix(import): handle a missing mapping",
      "feat(daemon): serve the dashboard",
      "fix(daemon): close the auth hole",
      "chore(daemon): tidy logs",
    ]);
    const byName = Object.fromEntries(themes.map((t) => [t.name, t.commits]));

    assert.equal(byName.daemon, 3);
    assert.equal(byName.import, 2);
    assert.ok(!("feat" in byName), "the conventional-commit verb is not a subject-matter theme");
    assert.ok(!("fix" in byName));
  });

  test("a multi-area scope counts for each area", () => {
    const themes = themesFromSubjects([
      "feat(import,daemon): thread the flag through",
      "feat(import,daemon): and again",
    ]);
    const names = themes.map((t) => t.name);
    assert.ok(names.includes("import"));
    assert.ok(names.includes("daemon"));
  });

  test("plain subjects fall back to repeated meaningful words", () => {
    const themes = themesFromSubjects([
      "add retry logic to the scheduler",
      "fix the scheduler retry backoff",
      "tune scheduler timings",
    ]);
    assert.ok(themes.some((t) => t.name === "scheduler" && t.commits === 3));
  });

  test("generic release vocabulary never becomes a theme", () => {
    const themes = themesFromSubjects([
      "update the readme", "update deps", "update deps again",
      "bump version", "bump version", "initial commit", "wip", "wip",
    ]);
    for (const junk of ["update", "bump", "wip", "initial", "commit", "the"]) {
      assert.ok(!themes.some((t) => t.name === junk), `"${junk}" says nothing about what the person works on`);
    }
  });

  test("a one-off is not a theme — it needs to recur", () => {
    assert.deepEqual(themesFromSubjects(["feat(oneoff): a single unusual commit"]), []);
  });

  test("no subjects yields nothing rather than throwing", () => {
    assert.deepEqual(themesFromSubjects([]), []);
  });
});

describe("languages from touched files", () => {
  test("counts by extension, most-touched first", () => {
    const langs = languagesFromPaths([
      "src/a.ts", "src/b.ts", "src/c.ts", "scripts/x.py", "README.md", "Makefile",
    ]);
    assert.equal(langs[0]!.name, "TypeScript");
    assert.equal(langs[0]!.files, 3);
    assert.ok(langs.some((l) => l.name === "Python" && l.files === 1));
    assert.ok(!langs.some((l) => l.name === "Markdown"), "only languages we map are counted");
  });

  test("reaches ecosystems the manifest table has no entry for", () => {
    // FRAMEWORKS knows Cargo/go.mod only as bare manifest presence, and nothing
    // at all about Ruby, Java or Elixir — files are how those become visible.
    const langs = languagesFromPaths(["a.rs", "b.go", "c.rb", "d.java", "e.ex"]).map((l) => l.name);
    for (const expected of ["Rust", "Go", "Ruby", "Java", "Elixir"]) {
      assert.ok(langs.includes(expected), `${expected} should be detected from files`);
    }
  });

  test("extensionless and unknown files are ignored", () => {
    assert.deepEqual(languagesFromPaths(["Dockerfile", "LICENSE", "a.unknownext"]), []);
  });
});

describe("a real repository, end to end", () => {
  const repoPath = join(tmp, "demo");

  const run = (...args: string[]) =>
    execFileSync("git", ["-C", repoPath, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });

  test("mines themes and languages from actual git history", () => {
    mkdirSync(join(repoPath, "src"), { recursive: true });
    execFileSync("git", ["init", "-q", repoPath]);
    run("config", "user.email", "dev@example.com");
    run("config", "user.name", "Dev");

    const commit = (file: string, body: string, subject: string) => {
      const full = join(repoPath, file);
      mkdirSync(join(repoPath, file.split("/").slice(0, -1).join("/")) || repoPath, { recursive: true });
      writeFileSync(full, body);
      run("add", "-A");
      run("-c", "user.email=dev@example.com", "commit", "-q", "-m", subject);
    };

    commit("src/importer.ts", "export const a = 1;", "feat(import): add the parser");
    commit("src/importer.ts", "export const a = 2;", "fix(import): handle empty input");
    commit("src/daemon.ts", "export const b = 1;", "feat(daemon): serve context");
    commit("scripts/tool.py", "print(1)", "chore(scripts): add a helper");

    const s = summarizeRepo(repoPath, "dev@example.com");

    assert.ok(s, "the repo summarized");
    assert.equal(s.commits, 4);
    assert.ok(s.themes.some((t) => t.name === "import" && t.commits === 2),
      `expected an "import" theme, got ${JSON.stringify(s.themes)}`);
    assert.ok(s.languages.some((l) => l.name === "TypeScript"));
    assert.ok(s.languages.some((l) => l.name === "Python"));
  });

  test("themes and languages become their own signals, not just repo metadata", () => {
    const s = summarizeRepo(repoPath, "dev@example.com")!;
    const { events } = gitEvents([s]);

    const topics = events.filter((e) => e.type === "signal.topic").map((e) => (e.payload as { topic: string }).topic);
    assert.ok(topics.includes("demo"), "the repo itself is still a topic");
    assert.ok(topics.includes("import"), "and so is what they actually work on — this is the whole fix");
    assert.ok(topics.length > 1, "a repo used to produce exactly one topic: its directory name");

    const skills = events.filter((e) => e.type === "signal.skill")
      .map((e) => (e.payload as { skill: string; domain: string }));
    assert.ok(skills.some((k) => k.skill === "TypeScript" && k.domain === "language"));
  });

  test("a repo with no commits by this author yields nothing, not a crash", () => {
    assert.equal(summarizeRepo(repoPath, "someone-else@example.com"), null);
  });
});
