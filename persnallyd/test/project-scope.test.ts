import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { newEvent } from "../src/events.js";
import { EventStore } from "../src/store.js";
import { projectKey, projectLabel } from "../src/importers/claude-code.js";
import { extractEvents, type ParsedExport } from "../src/importers/extract.js";
import type { LlmExtract } from "../src/llm.js";

const OPTS = { source: "import:claude-code", importer: "claude-code", file: "/x/.claude/projects" };
const extract: LlmExtract = () => Promise.resolve({ topics: [] });

const projectOf = (e: { provenance: unknown }) => (e.provenance as { project?: string }).project;

// ── identity ────────────────────────────────────────────────────────────────

test("a project is identified by its path, so short names cannot collide", () => {
  // Three different repos whose last segment is "website", and a monorepo
  // subdirectory whose name is generic everywhere.
  const keys = [
    "/Users/x/Projects/work-modelia/website",
    "/Users/x/Projects/other-client/website",
    "/Users/x/Projects/0byte/apps/web",
  ].map(projectKey);
  assert.equal(new Set(keys).size, 3, "two projects collapsed into one identity");
});

test("a git worktree belongs to the repo it came from", () => {
  assert.equal(
    projectKey("/Users/x/Projects/site/.claude-worktrees/pr-4465-review"),
    projectKey("/Users/x/Projects/site"),
    "reviewing a PR registered as a separate project",
  );
});

test("labels shorten to the last segment, unless that says nothing", () => {
  assert.equal(projectLabel("/Users/x/Projects/persnally"), "persnally");
  assert.equal(projectLabel("/Users/x/Projects/0byte/apps/web"), "apps/web");
});

// ── conventions, mined per project ──────────────────────────────────────────

/** Two sessions in different repos, each with an opposite package manager. */
function twoProjects(): ParsedExport {
  const session = (uuid: string, project: string | undefined, cmd: string) => ({
    uuid, name: uuid, summary: "", created_at: "2026-01-01T00:00:00Z",
    userMessages: ["installing dependencies and running the tests today."],
    toolCommands: Array.from({ length: 6 }, () => cmd),
    ...(project ? { project } : {}),
  });
  return {
    conversations: [
      session("a", "/repos/alpha", "pnpm install"),
      session("b", "/repos/beta", "npm install"),
    ],
    memoryText: "",
    projects: [],
  };
}

test("opposite conventions in two repos are both kept, each scoped to its own", async () => {
  // Pooling the commands produced one global winner, so a store asserted both
  // "prefers pnpm over npm" and the reverse — each true of a different repo.
  const { events } = await extractEvents(twoProjects(), OPTS, extract, "m", 2);
  const conventions = events.filter((e) => e.type === "signal.style"
    && (e.payload as { dimension: string }).dimension === "convention");

  const byProject = new Map(conventions.map((e) => [projectOf(e), (e.payload as { pattern: string }).pattern]));
  assert.equal(byProject.get("/repos/alpha"), "uses pnpm");
  assert.equal(byProject.get("/repos/beta"), "uses npm");
  // And neither is asserted about the person as a whole.
  assert.equal(conventions.filter((e) => projectOf(e) === undefined).length, 0);
});

test("topics carry the project they were learned in", async () => {
  const withTopics: LlmExtract = () => Promise.resolve({
    topics: [{
      topic: "dependency management", weight: 0.5, intent: "building",
      sentiment: "neutral", depth: "moderate", category: "technology", entities: [],
    }],
  });
  const { events } = await extractEvents(twoProjects(), OPTS, withTopics, "m", 2);
  const topics = events.filter((e) => e.type === "signal.topic");
  assert.deepEqual([...new Set(topics.map(projectOf))].sort(), ["/repos/alpha", "/repos/beta"]);
});

test("a source with no project still yields unscoped conventions", async () => {
  // ChatGPT and Claude exports have no workspace; their signals stay global.
  const parsed: ParsedExport = {
    conversations: [{
      uuid: "c", name: "c", summary: "", created_at: "2026-01-01T00:00:00Z",
      userMessages: ["running the tests before pushing anything today."],
      toolCommands: Array.from({ length: 6 }, () => "npm test"),
    }],
    memoryText: "",
    projects: [],
  };
  const { events } = await extractEvents(parsed, OPTS, extract, "m", 1);
  const conventions = events.filter((e) => e.type === "signal.style"
    && (e.payload as { dimension: string }).dimension === "convention");
  assert.ok(conventions.length > 0, "no conventions mined at all");
  for (const e of conventions) assert.equal(projectOf(e), undefined);
});

// ── serving: a project's conventions never leak into another ────────────────

test("voice serves the global layer plus this project, never another's", () => {
  const dir = mkdtempSync(join(tmpdir(), "persnallyd-scope-"));
  const store = new EventStore(join(dir, "s.db"));
  const style = (pattern: string, project?: string) =>
    newEvent("signal.style", "import:claude-code",
      { dimension: "convention", pattern, polarity: "prefers", confidence: 0.8, evidence: "observed", basis: "stylometry" },
      { kind: "import", batch: "b", file: "f", ...(project ? { project } : {}) });

  store.append([
    style("prefers pnpm over npm", "/repos/alpha"),
    style("prefers npm over pnpm", "/repos/beta"),
    style("works through GitHub PRs from the CLI"), // global: true everywhere
  ]);

  const alpha = store.voice("/repos/alpha").items.map((i) => i.pattern);
  assert.ok(alpha.includes("prefers pnpm over npm"));
  assert.ok(alpha.includes("works through GitHub PRs from the CLI"));
  assert.ok(!alpha.includes("prefers npm over pnpm"), "another project's convention leaked in");

  const beta = store.voice("/repos/beta").items.map((i) => i.pattern);
  assert.ok(beta.includes("prefers npm over pnpm"));
  assert.ok(!beta.includes("prefers pnpm over npm"));

  // With no project the two would contradict each other, so neither is served.
  const global = store.voice().items.map((i) => i.pattern);
  assert.deepEqual(global, ["works through GitHub PRs from the CLI"]);

  store.close();
  rmSync(dir, { recursive: true, force: true });
});
