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
    assert.ok(patterns(rep("python -m pytest tests/", 5)).includes("pytest"));
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

/**
 * Cases from review of #234, each of which the first rewrite got wrong. The
 * amend rule is the one that mattered most: dropping it would have deleted an
 * existing signal from every store on the next refresh, unrecoverably, because
 * nothing else can re-derive it.
 */
describe("shell shapes that fooled the first rewrite", () => {
  test("a separator inside quotes is text, not a command boundary", () => {
    assert.deepEqual(patterns(rep("echo 'npm test; pnpm install'", 20)), [],
      "the quoted string was split and counted as a pnpm invocation");
  });

  test("an option's value is not the subcommand", () => {
    assert.ok(patterns(rep("git -C /repo merge main", 20)).includes("uses merge"),
      "`git -C <path> merge` read /repo as the subcommand and missed the merge");
  });

  test("an option is never the executable", () => {
    assert.ok(patterns(rep("uv run --with pytest pytest -q", 5)).includes("pytest"),
      "`--with` was classified as the invoked tool");
  });

  test("git commit --amend is still a workflow signal", () => {
    // Option-qualified: `git commit` alone says nothing about how they work.
    assert.ok(patterns(rep("git commit --amend --no-edit", 5)).includes("amends commits"));
    assert.deepEqual(patterns(rep("git commit -m wip", 5)).filter((p) => /amend/.test(p)), []);
  });
});

/**
 * Both defects here were found by auditing what the product actually derived
 * for this repo, and both were self-inflicted by the work in #234.
 *
 * They pull in opposite directions and had been cancelling out: heredoc bodies
 * invented tools that were never run, while an apostrophe in prose swallowed
 * tools that were.
 */
describe("prose is not a command", () => {
  test("a heredoc body is data, not commands", () => {
    const cmd = "cat >> notes.md <<'EOF'\nnpm ci\npnpm install\nEOF\nnpm test";
    // Only the real invocations: cat, and the npm test after the delimiter.
    assert.deepEqual(patterns(rep(cmd, 5)).filter((p) => /npm|pnpm/.test(p)), ["uses npm"]);
  });

  test("a PR description cannot manufacture a convention", () => {
    // Four mentions clear MIN_USES, which is how this repo came to "prefer"
    // a test runner it has never once invoked.
    const cmd = "gh pr edit 1 --body-file - <<'BODY'\nwe should use pytest here\nBODY";
    assert.deepEqual(patterns(rep(cmd, 20)).filter((p) => /pytest/.test(p)), []);
  });

  test("\"make sure\" in prose is not the Make build tool", () => {
    const cmd = "gh pr edit 1 --body-file - <<'BODY'\nmake sure to run the tests\nBODY";
    assert.deepEqual(patterns(rep(cmd, 20)).filter((p) => /Make/.test(p)), []);
  });

  test("every heredoc declared on a line is tracked, in order", () => {
    // The shell reads bodies in declaration order. Tracking one delimiter ended
    // the strip at FIRST and parsed the second body as commands.
    const cmd = "cat <<FIRST <<SECOND\nalpha\nFIRST\nnpm ci\nSECOND";
    assert.deepEqual(patterns(rep(cmd, 20)).filter((p) => /npm/.test(p)), [],
      "a tool named only inside the second body was counted as run");
  });

  test("an unterminated heredoc treats the rest as body", () => {
    assert.deepEqual(patterns(rep("cat <<'EOF'\nnpm ci\nnpm ci", 20)).filter((p) => /npm/.test(p)), []);
  });

  test("an apostrophe in a comment does not swallow the next command", () => {
    // Quote state crossing a newline lost segments in 34% of multi-line
    // commands: everything after an unbalanced quote became quoted text.
    const cmd = "echo start\n// the daemon's timer wrapper\nnpm ci";
    assert.ok(patterns(rep(cmd, 5)).includes("uses npm"),
      "an unbalanced apostrophe hid every command after it");
  });

  test("a path-only token yields nothing", () => {
    assert.deepEqual(patterns(rep("// comment", 20)), []);
  });
});

/**
 * Coverage beyond the original rule set. The gap was concrete: this repo's test
 * runner is `node --test`, and the convention layer could not see it at all —
 * so the one question it should answer best about itself had no answer.
 */
describe("wider tool coverage", () => {
  test("node --test is a test runner, plain node is not", () => {
    assert.ok(patterns(rep("node --test build/test/x.js", 5)).includes("uses node --test"));
    assert.deepEqual(patterns(rep("node script.js", 5)).filter((p) => /node/.test(p)), []);
  });

  test("it competes with the other JS runners", () => {
    const cmds = [...rep("node --test build/test/x.js", 20), ...rep("vitest run", 3)];
    assert.ok(patterns(cmds).includes("prefers node --test over vitest"));
  });

  test("tools from different ecosystems are never framed as a preference", () => {
    // eslint and ruff both lint, but not the same language. "prefers ESLint over
    // Ruff" would state a choice the user never made.
    const both = [...rep("eslint .", 20), ...rep("ruff check .", 20)];
    const p = patterns(both);
    assert.ok(p.includes("uses ESLint") || p.includes("ESLint"), "ESLint should be reported");
    assert.ok(p.includes("uses Ruff") || p.includes("Ruff"), "Ruff should be reported");
    assert.deepEqual(p.filter((x) => /prefers (ESLint|Ruff)/.test(x)), []);
  });

  test("interchangeable tools do compete", () => {
    const cmds = [...rep("tsx script.ts", 20), ...rep("ts-node script.ts", 3)];
    assert.ok(patterns(cmds).includes("prefers tsx over ts-node"));
  });
});

/**
 * A family means *interchangeable for the same task in the same context*. The
 * looser reading ("same job") let the rules state choices nobody made, which is
 * worse than saying nothing: it gets injected into every AI the user connects.
 */
describe("preference is claimed only between interchangeable tools", () => {
  const bothOf = (a: string, b: string) => [...rep(a, 20), ...rep(b, 5)];

  test("two clouds are not a preference", () => {
    assert.deepEqual(patterns(bothOf("aws s3 ls", "az account show")), ["AWS CLI", "Azure CLI"]);
  });

  test("two hosts are not a preference", () => {
    assert.deepEqual(patterns(bothOf("vercel deploy", "fly deploy")), ["Vercel", "Fly.io"]);
  });

  test("the SQL client is decided by the datastore, not by taste", () => {
    assert.deepEqual(patterns(bothOf("sqlite3 t.db .tables", "psql -c x")).sort(), ["psql", "sqlite3"]);
  });

  test("test runners from different languages are not a preference", () => {
    // A Rust+Python monorepo does not "prefer" cargo test over pytest.
    assert.deepEqual(patterns(bothOf("cargo test", "python -m pytest")).sort(), ["cargo test", "pytest"]);
  });

  test("but runners for the same language are", () => {
    assert.deepEqual(patterns(bothOf("node --test x.js", "vitest run")), ["prefers node --test over vitest"]);
  });
});

describe("a command substitution contains a real command", () => {
  test("the tool inside $() is the invocation", () => {
    // `out=$(gh pr checks 1)` matched the env-assignment skip on `out=$(gh`,
    // consuming the command name and leaving `pr` as the executable — which then
    // showed up as one of this repo's most-used "tools".
    assert.ok(patterns(rep("out=$(gh pr checks 1 --repo x)", 5))
      .includes("works through GitHub PRs from the CLI"));
  });

  test("backticks too", () => {
    assert.ok(patterns(rep("v=`npm --version`", 5)).includes("uses npm"));
  });

  test("and the assignment itself is not a tool", () => {
    assert.deepEqual(patterns(rep("SHA=$(git rev-parse HEAD)", 20)).filter((p) => /rev-parse/.test(p)), []);
  });
});
