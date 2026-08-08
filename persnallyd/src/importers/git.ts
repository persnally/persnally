/**
 * Git history importer — fully deterministic, no LLM, works offline.
 * Repos become project topics; manifest dependencies become skill signals.
 * Carries forward the v1 skill_analyzer's framework-detection approach.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { newEvent, uuidv7, type PersnallyEvent } from "../events.js";

export interface RepoSummary {
  repo: string;
  path: string;
  commits: number;
  firstCommit: string;
  lastCommit: string;
  frameworks: string[];
  /** What the user actually worked on, mined deterministically from their own
      commits — subjects and touched paths. Empty on repos where git gave us
      nothing to read. */
  themes: { name: string; commits: number }[];
  languages: { name: string; files: number }[];
}

// The most recent N commits are read for subjects/paths. The full commit count
// still comes from the complete log — this only bounds how much text is mined,
// so a decade-old monorepo doesn't turn one import into a minute of git.
const MAX_ANALYZED_COMMITS = 1000;

/** Conventional-commit verbs and generic release words: frequent, and say
    nothing about what the person works on. */
const SUBJECT_STOP = new Set([
  "feat", "fix", "chore", "docs", "style", "refactor", "perf", "test", "build", "ci", "revert",
  "add", "adds", "added", "update", "updates", "updated", "remove", "removes", "removed",
  "bump", "merge", "initial", "commit", "wip", "cleanup", "clean", "rename", "move", "moved",
  "make", "makes", "use", "using", "support", "improve", "improves", "better", "small", "minor",
  "the", "and", "for", "with", "from", "into", "that", "this", "when", "then", "not", "its",
  "all", "new", "now", "out", "one", "two", "via", "per", "was", "are", "but", "can", "get",
  "set", "let", "run", "off", "back", "more", "less", "only", "also", "just", "some", "any",
]);

/** File extension → the language it implies. Deterministic, and reaches the
    ecosystems the manifest-based FRAMEWORKS table can't see at all. */
const LANGUAGES: Record<string, string> = {
  ts: "TypeScript", tsx: "TypeScript", js: "JavaScript", jsx: "JavaScript", mjs: "JavaScript",
  py: "Python", rs: "Rust", go: "Go", java: "Java", kt: "Kotlin", swift: "Swift",
  rb: "Ruby", php: "PHP", cs: "C#", cpp: "C++", cc: "C++", c: "C", h: "C",
  sh: "Shell", sql: "SQL", scala: "Scala", ex: "Elixir", exs: "Elixir", zig: "Zig",
};

const FRAMEWORKS: Record<string, string> = {
  // js/ts
  react: "frontend", next: "frontend", vue: "frontend", svelte: "frontend", "solid-js": "frontend",
  tailwindcss: "frontend", express: "backend", fastify: "backend", hono: "backend", nestjs: "backend",
  "better-sqlite3": "backend", prisma: "backend", drizzle: "backend", zod: "backend",
  "@modelcontextprotocol/sdk": "ai_ml", "@anthropic-ai/sdk": "ai_ml", openai: "ai_ml", langchain: "ai_ml",
  electron: "desktop", "react-native": "mobile", expo: "mobile",
  // python
  fastapi: "backend", django: "backend", flask: "backend", sqlalchemy: "backend", pydantic: "backend",
  torch: "ai_ml", tensorflow: "ai_ml", transformers: "ai_ml", anthropic: "ai_ml", pandas: "data",
  numpy: "data", "scikit-learn": "data",
  // other ecosystems (manifest presence)
  cargo: "systems", "go.mod": "backend",
};

/** Pure: manifest filename → content → detected framework names. */
export function detectFrameworks(manifests: Record<string, string>): string[] {
  const found = new Set<string>();
  for (const [name, content] of Object.entries(manifests)) {
    if (name === "package.json") {
      try {
        const pkg = JSON.parse(content) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
        for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
          if (FRAMEWORKS[dep]) found.add(dep);
        }
      } catch { /* unparseable manifest — skip, not fatal */ }
    }
    if (name === "requirements.txt" || name === "pyproject.toml") {
      for (const fw of Object.keys(FRAMEWORKS)) {
        if (new RegExp(`\\b${fw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(content)) found.add(fw);
      }
    }
    if (name === "Cargo.toml") found.add("cargo");
    if (name === "go.mod") found.add("go.mod");
  }
  return [...found];
}

function git(repoPath: string, args: string[]): string {
  // A repo with a stuck credential helper, or an enormous history, must not
  // wedge the whole import — bound both time and output.
  return execFileSync("git", ["-C", repoPath, ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 30_000,
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

/**
 * What the person keeps working on, from their own commit subjects. Prefers
 * conventional-commit scopes (`feat(import): …` → "import") because they are
 * an explicit, high-precision statement of the area touched; falls back to
 * repeated meaningful words. Requires ≥2 commits so a one-off never becomes a
 * "theme".
 */
export function themesFromSubjects(subjects: string[]): { name: string; commits: number }[] {
  const counts = new Map<string, number>();
  const bump = (k: string) => counts.set(k, (counts.get(k) ?? 0) + 1);

  for (const subject of subjects) {
    const scope = /^[a-z]+\(([^)]+)\)!?:/i.exec(subject.trim());
    if (scope) {
      for (const part of scope[1]!.split(/[,/]/)) {
        const name = part.trim().toLowerCase();
        if (name && name.length > 1 && !SUBJECT_STOP.has(name)) bump(name);
      }
      continue;
    }
    const words = subject.toLowerCase().replace(/^[a-z]+!?:\s*/i, "").match(/[a-z][a-z0-9.-]{2,}/g) ?? [];
    for (const w of new Set(words)) {
      if (!SUBJECT_STOP.has(w)) bump(w);
    }
  }

  return [...counts.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([name, commits]) => ({ name, commits }));
}

/** Languages the person actually writes, by how many of their touched files
    carry each extension. Reaches ecosystems the manifest table can't see. */
export function languagesFromPaths(paths: string[]): { name: string; files: number }[] {
  const counts = new Map<string, number>();
  for (const p of paths) {
    const ext = p.includes(".") ? p.slice(p.lastIndexOf(".") + 1).toLowerCase() : "";
    const lang = LANGUAGES[ext];
    if (lang) counts.set(lang, (counts.get(lang) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name, files]) => ({ name, files }));
}

export function summarizeRepo(repoPath: string, authorEmail?: string): RepoSummary | null {
  if (!existsSync(join(repoPath, ".git"))) return null;
  const author = authorEmail ?? git(repoPath, ["config", "user.email"]);
  if (!author) return null;

  const log = git(repoPath, ["log", `--author=${author}`, "--format=%aI", "--no-merges"]);
  if (!log) return null;
  const dates = log.split("\n");

  // Subjects and touched paths — the user's own words about their own work,
  // and which parts of the system they actually touch. Read separately from
  // the date log so a failure here can't cost us the repo entirely.
  let themes: { name: string; commits: number }[] = [];
  let languages: { name: string; files: number }[] = [];
  try {
    const subjects = git(repoPath, [
      "log", `--author=${author}`, "--no-merges", "--format=%s", `-n${MAX_ANALYZED_COMMITS}`,
    ]).split("\n").filter(Boolean);
    themes = themesFromSubjects(subjects);

    const paths = git(repoPath, [
      "log", `--author=${author}`, "--no-merges", "--format=", "--name-only", `-n${MAX_ANALYZED_COMMITS}`,
    ]).split("\n").filter(Boolean);
    languages = languagesFromPaths(paths);
  } catch {
    // A repo git can't fully read still yields its commit cadence and manifests.
  }

  const manifests: Record<string, string> = {};
  for (const name of ["package.json", "requirements.txt", "pyproject.toml", "Cargo.toml", "go.mod"]) {
    const p = join(repoPath, name);
    if (existsSync(p)) manifests[name] = readFileSync(p, "utf-8");
  }

  return {
    repo: basename(repoPath),
    path: repoPath,
    commits: dates.length,
    firstCommit: dates[dates.length - 1]!,
    lastCommit: dates[0]!,
    frameworks: detectFrameworks(manifests),
    themes,
    languages,
  };
}

/** A path is either a repo or a directory of repos — resolve to repo summaries. */
export function scanRepos(path: string, authorEmail?: string): RepoSummary[] {
  const direct = summarizeRepo(path, authorEmail);
  if (direct) return [direct];
  // Not a repo — must be a folder of repos. A file path here is user error,
  // not a crash (readdirSync would throw ENOTDIR).
  if (!existsSync(path) || !statSync(path).isDirectory()) return [];
  return readdirSync(path, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => { try { return summarizeRepo(join(path, d.name), authorEmail); } catch { return null; } })
    .filter((s): s is RepoSummary => s !== null);
}

export function gitEvents(summaries: RepoSummary[]): { events: PersnallyEvent[]; batch: string } {
  const batch = uuidv7();
  const events: PersnallyEvent[] = [];
  const activity = (commits: number) => Math.min(Math.log2(commits + 1) / 8, 1);

  for (const s of summaries) {
    events.push(newEvent("signal.topic", "import:git", {
      topic: s.repo,
      weight: Math.max(activity(s.commits), 0.1),
      intent: "building",
      sentiment: "neutral",
      depth: s.commits > 50 ? "deep" : s.commits > 10 ? "moderate" : "mention",
      category: "technology",
      entities: s.frameworks.slice(0, 10),
    }, { kind: "git", repo: s.repo, batch }, s.lastCommit));

    // What they keep working on inside the repo — one topic per recurring
    // theme, weighted by how much of their history mentions it. This is the
    // difference between knowing someone has a repo called "persnally" and
    // knowing they work on imports, decay and the daemon.
    for (const t of s.themes) {
      const share = t.commits / Math.max(s.commits, 1);
      events.push(newEvent("signal.topic", "import:git", {
        topic: t.name,
        weight: Math.min(Math.max(share * 2, 0.15), 1),
        intent: "building",
        sentiment: "neutral",
        depth: t.commits > 20 ? "deep" : t.commits > 5 ? "moderate" : "mention",
        category: "technology",
        entities: [s.repo],
      }, { kind: "git", repo: s.repo, batch }, s.lastCommit));
    }

    for (const fw of s.frameworks) {
      events.push(newEvent("signal.skill", "import:git", {
        skill: fw,
        domain: FRAMEWORKS[fw] ?? "other",
        proficiency: activity(s.commits),
        basis: `repo-activity:${s.repo}`,
      }, { kind: "git", repo: s.repo, batch }, s.lastCommit));
    }

    // Languages come from files they actually touched, so this covers
    // ecosystems the manifest table has no entry for at all.
    for (const lang of s.languages) {
      events.push(newEvent("signal.skill", "import:git", {
        skill: lang.name,
        domain: "language",
        proficiency: Math.min(Math.log2(lang.files + 1) / 8, 1),
        basis: `files-touched:${s.repo}`,
      }, { kind: "git", repo: s.repo, batch }, s.lastCommit));
    }
  }

  events.push(newEvent("system.import", "system", {
    importer: "git",
    batch,
    events: events.length,
  }, { kind: "import", batch, file: summaries.map((s) => s.repo).join(",") }));

  return { events, batch };
}
