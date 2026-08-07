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
  /** Matched against the command string, word-bounded. */
  match: RegExp;
  /** Competing tools are compared within a family; a lone tool still counts. */
  family: string;
  label: string;
  dimension: "convention" | "workflow";
}

const RULES: ToolRule[] = [
  // Package managers — the most-asked "which one do they use".
  { match: /\bpnpm\b/, family: "package-manager", label: "pnpm", dimension: "convention" },
  { match: /\bnpm\b/, family: "package-manager", label: "npm", dimension: "convention" },
  { match: /\byarn\b/, family: "package-manager", label: "yarn", dimension: "convention" },
  { match: /\bbun\b/, family: "package-manager", label: "bun", dimension: "convention" },
  // Test runners.
  { match: /\bvitest\b/, family: "test-runner", label: "vitest", dimension: "convention" },
  { match: /\bjest\b/, family: "test-runner", label: "jest", dimension: "convention" },
  { match: /\bpytest\b/, family: "test-runner", label: "pytest", dimension: "convention" },
  { match: /\bcargo\s+test\b/, family: "test-runner", label: "cargo test", dimension: "convention" },
  { match: /\bgo\s+test\b/, family: "test-runner", label: "go test", dimension: "convention" },
  // Search tools.
  // Short names, so they must appear as an invoked command (line start or
  // after a pipe/separator) — a bare \brg\b would match inside unrelated text.
  { match: /(^|[|&;]\s*)rg\s/, family: "search", label: "ripgrep", dimension: "convention" },
  { match: /(^|[|&;]\s*)grep\s/, family: "search", label: "grep", dimension: "convention" },
  { match: /(^|[|&;]\s*)fd\s/, family: "find", label: "fd", dimension: "convention" },
  { match: /(^|[|&;]\s*)find\s+[./~]/, family: "find", label: "find", dimension: "convention" },
  // How history gets integrated — a genuine workflow preference.
  { match: /\bgit\s+rebase\b/, family: "git-integrate", label: "rebase", dimension: "workflow" },
  // `merge-base` is a plumbing lookup, not an integration choice.
  { match: /\bgit\s+merge(?![-\w])/, family: "git-integrate", label: "merge", dimension: "workflow" },
  // Standalone workflow habits (no competitor — presence is the signal).
  { match: /\bgit\s+commit\s+[^|&;]*--amend\b/, family: "amend", label: "amends commits", dimension: "workflow" },
  { match: /\bgh\s+pr\b/, family: "gh-pr", label: "works through GitHub PRs from the CLI", dimension: "workflow" },
  { match: /\bdocker(\s|-)/, family: "docker", label: "Docker", dimension: "convention" },
  { match: /\bkubectl\b/, family: "k8s", label: "kubectl", dimension: "convention" },
  { match: /\bterraform\b/, family: "terraform", label: "Terraform", dimension: "convention" },
  { match: /\bmake\s+\w/, family: "make", label: "Make", dimension: "convention" },
];

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
    const cmd = raw.trim();
    if (!cmd) continue;
    for (const rule of RULES) {
      if (rule.match.test(cmd)) counts.set(rule.label, (counts.get(rule.label) ?? 0) + 1);
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
