/**
 * Workflow and convention signals, mined deterministically from the shell
 * commands run in Claude Code sessions. Zero tokens, no model.
 *
 * This is the prescriptive half of the context docs/CONTEXT_DEPTH.md describes,
 * and until now nothing produced it: the `convention` and `workflow` dimensions
 * existed in the schema and were rendered by the dashboard, but no importer
 * emitted either. Meanwhile every transcript carried the answer — which package
 * manager, which test runner, rebase or merge — in the commands themselves.
 *
 * What this claims is deliberately modest: these are tools observed in the
 * user's own workspace, which is evidence of their setup and habits, not a
 * statement they made about themselves. Confidence stays below the level of a
 * stated correction, and the evidence line always says it was observed.
 */

import type { StyleSignal } from "./stylometry.js";

/** A tool worth noticing, and the family it competes within. */
interface ToolRule {
  /** Matched against the *executable* of each command segment, never the whole
      command string: `rg pnpm package.json` runs ripgrep and merely mentions
      pnpm. Optional `sub` additionally requires a subcommand (`git rebase`). */
  exe: string;
  sub?: string;
  /** Competing tools are compared within a family; a lone tool still counts. */
  family: string;
  label: string;
  dimension: "convention" | "workflow";
}

const RULES: ToolRule[] = [
  // Package managers — the most-asked "which one do they use".
  { exe: "pnpm", family: "package-manager", label: "pnpm", dimension: "convention" },
  { exe: "npm", family: "package-manager", label: "npm", dimension: "convention" },
  { exe: "yarn", family: "package-manager", label: "yarn", dimension: "convention" },
  { exe: "bun", family: "package-manager", label: "bun", dimension: "convention" },
  // Test runners.
  { exe: "vitest", family: "test-runner", label: "vitest", dimension: "convention" },
  { exe: "jest", family: "test-runner", label: "jest", dimension: "convention" },
  { exe: "pytest", family: "test-runner", label: "pytest", dimension: "convention" },
  { exe: "cargo", sub: "test", family: "test-runner", label: "cargo test", dimension: "convention" },
  { exe: "go", sub: "test", family: "test-runner", label: "go test", dimension: "convention" },
  // Search tools.
  { exe: "rg", family: "search", label: "ripgrep", dimension: "convention" },
  { exe: "grep", family: "search", label: "grep", dimension: "convention" },
  { exe: "fd", family: "find", label: "fd", dimension: "convention" },
  { exe: "find", family: "find", label: "find", dimension: "convention" },
  // How history gets integrated — a genuine workflow preference.
  { exe: "git", sub: "rebase", family: "git-integrate", label: "rebase", dimension: "workflow" },
  { exe: "git", sub: "merge", family: "git-integrate", label: "merge", dimension: "workflow" },
  // Standalone workflow habits (no competitor — presence is the signal).
  { exe: "gh", sub: "pr", family: "gh-pr", label: "works through GitHub PRs from the CLI", dimension: "workflow" },
  { exe: "docker", family: "docker", label: "Docker", dimension: "convention" },
  { exe: "kubectl", family: "k8s", label: "kubectl", dimension: "convention" },
  { exe: "terraform", family: "terraform", label: "Terraform", dimension: "convention" },
  { exe: "make", family: "make", label: "Make", dimension: "convention" },
];

/** Wrappers that delegate to the tool that follows them. */
const WRAPPERS = new Set(["sudo", "time", "env", "npx", "bunx", "command", "nohup", "xargs"]);

/** Runners that delegate only before a specific token: `python -m pytest`
    invokes pytest, `python script.py` invokes python. */
const DELEGATORS: Record<string, string> = {
  python: "-m", python3: "-m", uv: "run", poetry: "run", pipenv: "run", pdm: "run",
};

/**
 * The (executable, subcommand) pairs a command line invokes — one per pipeline
 * or compound segment, with arguments ignored by construction.
 *
 * This is deliberately a second implementation of the same idea as the
 * benchmark's `bench/ground-truth.mjs`. Sharing one parser would let a single
 * bug decide both the product's answer and the answer key it is graded
 * against — which is how this defect survived here in the first place: the two
 * differed only because the key was rewritten, and the difference is what
 * exposed it.
 */
export function invocations(command: string): { exe: string; sub?: string }[] {
  const out: { exe: string; sub?: string }[] = [];
  for (const seg of command.split(/\|\||&&|[|;&\n]/)) {
    const tokens = seg.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    for (;;) {
      while (i < tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!) || WRAPPERS.has(tokens[i]!))) i++;
      const delegate = DELEGATORS[tokens[i] ?? ""];
      if (delegate && tokens[i + 1] === delegate) { i += 2; continue; }
      break;
    }
    const exe = tokens[i];
    if (!exe) continue;
    out.push({ exe: exe.split("/").pop()!, sub: tokens.slice(i + 1).find((t) => !t.startsWith("-")) });
  }
  return out;
}

// A handful of uses is noise (one-off experiment, a suggestion the user
// rejected); a habit shows up repeatedly.
const MIN_USES = 3;
// Within a family, a tool has to clearly lead before we call it a preference.
const DOMINANCE = 2;

/**
 * Turns observed shell commands into convention/workflow signals. Within a
 * competing family (pnpm vs npm) only a clear leader is reported, and it's
 * reported *as* a preference; a tool with no competitor is reported as plain
 * usage.
 */
export function toolConventions(commands: string[]): StyleSignal[] {
  const counts = new Map<string, number>();
  for (const raw of commands) {
    for (const inv of invocations(raw)) {
      for (const rule of RULES) {
        if (inv.exe === rule.exe && (rule.sub === undefined || inv.sub === rule.sub)) {
          counts.set(rule.label, (counts.get(rule.label) ?? 0) + 1);
        }
      }
    }
  }

  const byFamily = new Map<string, ToolRule[]>();
  for (const rule of RULES) {
    byFamily.set(rule.family, [...(byFamily.get(rule.family) ?? []), rule]);
  }

  const signals: StyleSignal[] = [];
  for (const rules of byFamily.values()) {
    // Rank on raw counts: the *leader* has to clear the noise floor, but the
    // comparison must see every competitor. Filtering first made a small-but-
    // real rival disappear, downgrading a genuine "prefers X over Y" to a bare
    // "uses X" and losing the more useful half of the signal.
    const ranked = rules
      .map((r) => ({ rule: r, n: counts.get(r.label) ?? 0 }))
      .filter((x) => x.n > 0)
      .sort((a, b) => b.n - a.n);

    const top = ranked[0];
    if (!top || top.n < MIN_USES) continue;
    const runnerUp = ranked[1];
    // A contested family with no clear leader says nothing useful — the user
    // demonstrably uses both, so claiming a preference would be wrong.
    if (runnerUp && top.n < runnerUp.n * DOMINANCE) continue;

    const contested = rules.length > 1 && runnerUp !== undefined;
    signals.push({
      dimension: top.rule.dimension,
      pattern: contested
        ? `prefers ${top.rule.label} over ${runnerUp.rule.label}`
        : rules.length > 1 ? `uses ${top.rule.label}` : top.rule.label,
      polarity: contested ? "prefers" : "does",
      // Caps below a stated correction: this is inferred from a workspace, not
      // something the user told us.
      confidence: Math.min(0.5 + top.n / 40, 0.85),
      evidence: `observed in ${top.n} command(s) across Claude Code sessions`,
      basis: "stylometry",
    });
  }
  return signals;
}
