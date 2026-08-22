/**
 * Convention and workflow signals from shell commands. Both dimensions existed
 * in the schema and were rendered by the dashboard, but nothing emitted either
 * — while every Claude Code transcript carried the answer (which package
 * manager, which test runner, rebase or merge) in the commands themselves.
 *
 * The interesting cases here are the ones that must NOT produce a signal:
 * claiming a preference the evidence doesn't support is worse than staying
 * quiet, because it gets injected into every AI the user connects.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { PAYLOAD_SCHEMAS } from "../src/events.js";
import { toolConventions } from "../src/workflow.js";

const rep = (cmd: string, n: number) => Array.from({ length: n }, () => cmd);
const patterns = (cmds: string[]) => toolConventions(cmds).map((s) => s.pattern);

describe("a clear preference is reported", () => {
  test("a dominant package manager wins its family", () => {
    const p = patterns([...rep("pnpm install", 10), ...rep("npm run build", 2)]);
    assert.ok(p.includes("prefers pnpm over npm"), `got ${JSON.stringify(p)}`);
  });

  test("rebase vs merge is reported as a workflow preference", () => {
    const signals = toolConventions([...rep("git rebase -i main", 12), ...rep("git merge main", 1)]);
    const s = signals.find((x) => /rebase/.test(x.pattern));
    assert.ok(s);
    assert.equal(s.dimension, "workflow");
    assert.equal(s.polarity, "prefers");
  });

  test("a tool with no competitor is reported as plain usage, not a preference", () => {
    const signals = toolConventions(rep("docker compose up", 5));
    const s = signals.find((x) => /Docker/.test(x.pattern));
    assert.ok(s);
    assert.equal(s.polarity, "does", "there is nothing to prefer it over");
  });
});

describe("silence when the evidence doesn't support a claim", () => {
  test("a genuinely contested family produces nothing", () => {
    // Real numbers from this machine: npm 408, pnpm 346. The user demonstrably
    // uses both — asserting a preference either way would be wrong.
    const p = patterns([...rep("npm ci", 40), ...rep("pnpm install", 34)]);
    assert.ok(!p.some((x) => /pnpm|npm/.test(x)),
      `a contested family must stay silent, got ${JSON.stringify(p)}`);
  });

  test("a one-off never becomes a habit", () => {
    assert.deepEqual(patterns(["terraform apply", "terraform plan"]), [],
      "two uses is an experiment, not a convention");
  });

  test("no commands yields no signals", () => {
    assert.deepEqual(toolConventions([]), []);
    assert.deepEqual(toolConventions(["", "   "]), []);
  });
});

describe("precision of the matchers", () => {
  test("`git merge-base` is a plumbing lookup, not an integration choice", () => {
    // This was a real false positive: 58 of 234 apparent "merges" on this
    // machine were merge-base lookups.
    const p = patterns(rep("git merge-base --is-ancestor abc HEAD", 20));
    assert.ok(!p.some((x) => /merge/.test(x)), `got ${JSON.stringify(p)}`);
  });

  test("short tool names must be invoked, not merely mentioned", () => {
    // A bare /\brg\b/ would match this; it's a path fragment, not ripgrep.
    const p = patterns(rep("cat /var/log/rg/output.txt", 20));
    assert.ok(!p.some((x) => /ripgrep/.test(x)), `got ${JSON.stringify(p)}`);
  });

  test("a tool invoked after a pipe still counts — that is a real invocation", () => {
    const p = patterns(rep("cat file.txt | grep needle", 10));
    assert.ok(p.some((x) => /grep/.test(x)), `got ${JSON.stringify(p)}`);
  });
});

describe("the emitted signals are well-formed and honestly framed", () => {
  test("every signal validates against the style schema", () => {
    const signals = toolConventions([
      ...rep("pnpm test", 10), ...rep("git rebase main", 8), ...rep("docker build .", 5),
    ]);
    assert.ok(signals.length > 0);
    for (const s of signals) PAYLOAD_SCHEMAS["signal.style"].parse(s);
  });

  test("confidence stays below a stated correction, and evidence says it was observed", () => {
    const signals = toolConventions(rep("pnpm install", 5000));
    for (const s of signals) {
      assert.ok(s.confidence <= 0.85,
        "inferred from a workspace — it must never outrank something the user actually told us");
      assert.match(s.evidence, /observed in \d+ command/);
      assert.equal(s.basis, "stylometry", "deterministic derivation, not a live observation");
    }
  });

  test("only convention and workflow dimensions are produced", () => {
    const dims = new Set(toolConventions([
      ...rep("pnpm i", 5), ...rep("git rebase x", 5), ...rep("gh pr create", 5),
    ]).map((s) => s.dimension));
    assert.deepEqual([...dims].sort(), ["convention", "workflow"]);
  });
});

describe("the signals reach the event stream, not just the function", () => {
  test("extractEvents emits convention/workflow style events from a session's commands", async () => {
    const { extractEvents } = await import("../src/importers/extract.js");
    const noTopics = () => Promise.resolve({ topics: [], assertions: [] });

    const { events } = await extractEvents({
      conversations: [{
        uuid: "s1", name: "session", summary: "", created_at: "2026-08-01T00:00:00Z",
        userMessages: ["ship it"],
        toolCommands: [...rep("pnpm install", 10), ...rep("git rebase main", 8)],
      }],
      memoryText: "",
      projects: [],
    }, { source: "import:claude-code", importer: "claude-code", file: "f" }, noTopics, "m");

    const style = events
      .filter((e) => e.type === "signal.style")
      .map((e) => e.payload as { dimension: string; pattern: string });

    assert.ok(style.some((s) => s.dimension === "convention" && /pnpm/.test(s.pattern)),
      `expected a pnpm convention signal, got ${JSON.stringify(style)}`);
    assert.ok(style.some((s) => s.dimension === "workflow" && /rebase/.test(s.pattern)),
      "and a workflow signal — these two dimensions previously had no producer at all");
  });
});

/**
 * The rules used to be matched against the whole command string, so a command
 * that merely *mentioned* a tool counted as using it. `rg pnpm package.json`
 * searches for the text "pnpm" with ripgrep; it credited pnpm. In one real
 * workspace that inverted a family outright, and the same defect in the
 * benchmark's answer key survived only because the two were written separately.
 */
describe("only the invoked executable counts, never the arguments", () => {
  test("searching for a tool's name is not using it", () => {
    const cmds = [...rep("rg pnpm package.json", 20), ...rep("npm test", 5)];
    assert.deepEqual(patterns(cmds).filter((p) => /pnpm|npm/.test(p)), ["uses npm"],
      "a ripgrep search for 'pnpm' was counted as pnpm usage");
  });

  test("a quoted argument is not an invocation", () => {
    assert.deepEqual(patterns(rep('grep -r "npm install" .', 20)).filter((p) => /npm/.test(p)), []);
  });

  test("wrappers delegate to the tool they run", () => {
    assert.ok(patterns(rep("npx vitest run", 5)).includes("uses vitest"), "npx should delegate");
    assert.ok(patterns(rep("sudo docker ps", 5)).includes("Docker"), "sudo should delegate");
  });

  test("python -m pytest is pytest, python script.py is not", () => {
    assert.ok(patterns(rep("python -m pytest tests/", 5)).includes("uses pytest"));
    assert.deepEqual(patterns(rep("python manage.py migrate", 5)).filter((p) => /pytest/.test(p)), []);
  });

  test("each pipeline segment is classified separately", () => {
    // The tool actually invoked on each side, so `cat | grep` is one grep use.
    assert.ok(patterns(rep("cat package.json | grep pnpm", 20)).includes("uses grep"));
    assert.deepEqual(patterns(rep("cat package.json | grep pnpm", 20)).filter((p) => /pnpm/.test(p)), []);
  });

  test("a subcommand rule needs its subcommand", () => {
    assert.deepEqual(patterns(rep("git merge-base main HEAD", 20)).filter((p) => /merge/.test(p)), [],
      "merge-base is a plumbing lookup, not an integration choice");
    assert.ok(patterns(rep("git merge --no-ff main", 20)).includes("uses merge"));
  });
});

describe("a convention states how much behaviour backs it", () => {
  test("the observed count survives into what is served", async () => {
    const { statedConvention } = await import("../src/stylometry.js");
    const [signal] = toolConventions(rep("npm ci", 12));
    assert.ok(signal, "expected a signal");
    // The count is the whole reason to trust this over a claim a model once
    // extracted from prose; it used to be dropped at serve time.
    assert.match(statedConvention(signal), /observed in 12 commands here/);
  });

  test("a signal with no count is served unchanged", async () => {
    const { statedConvention } = await import("../src/stylometry.js");
    assert.equal(statedConvention({ pattern: "wants approval before force-push" }),
      "wants approval before force-push");
  });
});
