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
  /** Required option, for rules the executable alone cannot express:
      `git commit --amend` is a habit, `git commit` is not. */
  flag?: string;
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
  { exe: "vitest", family: "test-runner-js", label: "vitest", dimension: "convention" },
  { exe: "jest", family: "test-runner-js", label: "jest", dimension: "convention" },
  { exe: "pytest", family: "test-runner-py", label: "pytest", dimension: "convention" },
  { exe: "cargo", sub: "test", family: "test-runner-rust", label: "cargo test", dimension: "convention" },
  { exe: "go", sub: "test", family: "test-runner-go", label: "go test", dimension: "convention" },
  // Search tools.
  { exe: "rg", family: "search", label: "ripgrep", dimension: "convention" },
  { exe: "grep", family: "search", label: "grep", dimension: "convention" },
  { exe: "fd", family: "find", label: "fd", dimension: "convention" },
  { exe: "find", family: "find", label: "find", dimension: "convention" },
  // How history gets integrated — a genuine workflow preference.
  { exe: "git", sub: "rebase", family: "git-integrate", label: "rebase", dimension: "workflow" },
  { exe: "git", sub: "merge", family: "git-integrate", label: "merge", dimension: "workflow" },
  // Standalone workflow habits (no competitor — presence is the signal).
  { exe: "git", sub: "commit", flag: "--amend", family: "amend", label: "amends commits", dimension: "workflow" },
  { exe: "gh", sub: "pr", family: "gh-pr", label: "works through GitHub PRs from the CLI", dimension: "workflow" },
  { exe: "docker", family: "docker", label: "Docker", dimension: "convention" },
  { exe: "kubectl", family: "k8s", label: "kubectl", dimension: "convention" },
  { exe: "terraform", family: "terraform", label: "Terraform", dimension: "convention" },
  { exe: "make", family: "make", label: "Make", dimension: "convention" },

  // A "family" is tools that are *interchangeable for the same task in the same
  // context*, because the output is phrased as a preference. That test is
  // stricter than "same job": psql and sqlite3 are both SQL clients, but which
  // one you run is decided by the datastore, not by taste, so "prefers sqlite3
  // over psql" states a choice nobody made. Same for two clouds, two hosts, and
  // two test runners from different languages. Anything not interchangeable gets
  // its own family and is reported as plain usage.
  { exe: "node", flag: "--test", family: "test-runner-js", label: "node --test", dimension: "convention" },
  { exe: "eslint", family: "lint-js", label: "ESLint", dimension: "convention" },
  { exe: "biome", family: "lint-js", label: "Biome", dimension: "convention" },
  { exe: "ruff", family: "lint-py", label: "Ruff", dimension: "convention" },
  { exe: "flake8", family: "lint-py", label: "flake8", dimension: "convention" },
  { exe: "pylint", family: "lint-py", label: "Pylint", dimension: "convention" },
  { exe: "prettier", family: "format-js", label: "Prettier", dimension: "convention" },
  { exe: "tsc", family: "typecheck-ts", label: "tsc", dimension: "convention" },
  { exe: "mypy", family: "typecheck-py", label: "mypy", dimension: "convention" },
  { exe: "tsx", family: "ts-runner", label: "tsx", dimension: "convention" },
  { exe: "ts-node", family: "ts-runner", label: "ts-node", dimension: "convention" },
  { exe: "psql", family: "db-postgres", label: "psql", dimension: "convention" },
  { exe: "mysql", family: "db-mysql", label: "mysql", dimension: "convention" },
  { exe: "sqlite3", family: "db-sqlite", label: "sqlite3", dimension: "convention" },
  { exe: "mongosh", family: "db-mongo", label: "mongosh", dimension: "convention" },
  { exe: "aws", family: "cloud-aws", label: "AWS CLI", dimension: "convention" },
  { exe: "az", family: "cloud-az", label: "Azure CLI", dimension: "convention" },
  { exe: "gcloud", family: "cloud-gcloud", label: "gcloud", dimension: "convention" },
  { exe: "vercel", family: "deploy-vercel", label: "Vercel", dimension: "convention" },
  { exe: "fly", family: "deploy-fly", label: "Fly.io", dimension: "convention" },
  { exe: "wrangler", family: "deploy-cf", label: "Cloudflare Workers", dimension: "convention" },
  { exe: "netlify", family: "deploy-netlify", label: "Netlify", dimension: "convention" },
];

/** Wrappers that delegate to the tool that follows them. */
const WRAPPERS = new Set(["sudo", "time", "env", "npx", "bunx", "command", "nohup", "xargs"]);

/** Runners that delegate only before a specific token: `python -m pytest`
    invokes pytest, `python script.py` invokes python. */
const DELEGATORS: Record<string, string> = {
  python: "-m", python3: "-m", uv: "run", poetry: "run", pipenv: "run", pdm: "run",
};

/**
 * Options that consume the next token, so a value is never mistaken for the
 * command or its subcommand: `git -C /repo merge` is a merge, and
 * `uv run --with pytest pytest` invokes pytest, not `--with`.
 */
const VALUE_FLAGS = new Set([
  "-C", "-c", "--git-dir", "--work-tree", "--with", "--python", "--directory", "-f", "--file",
]);

export interface Invocation {
  exe: string;
  sub?: string;
  flags: string[];
}

/**
 * Heredoc bodies are data being written, not commands being run. A PR
 * description passed through `gh pr edit --body-file - <<'BODY'` counted every
 * tool it merely *mentioned*, and four such mentions clear MIN_USES and
 * manufacture a convention that is simply false.
 */
function stripHeredocBodies(command: string): string {
  const kept: string[] = [];
  // One line may declare several (`cat <<FIRST <<SECOND`), and the shell reads
  // their bodies in declaration order. Tracking a single delimiter ended the
  // strip at the first terminator and parsed the second body as commands.
  const pending: string[] = [];
  for (const line of command.split("\n")) {
    if (pending.length) {
      if (line.trim() === pending[0]) pending.shift();
      continue;
    }
    kept.push(line);
    // An unterminated heredoc means the rest of the capture is body.
    for (const m of line.matchAll(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g)) pending.push(m[2]!);
  }
  return kept.join("\n");
}

/**
 * Command segments as token lists, quote-aware: a separator inside quotes is
 * text, not a boundary. Splitting the raw string made
 * `echo 'npm test; pnpm install'` report a pnpm invocation.
 */
function segments(command: string): string[][] {
  const segs: string[][] = [];
  let tokens: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  const endToken = (): void => { if (cur) { tokens.push(cur); cur = ""; } };
  const endSegment = (): void => { endToken(); if (tokens.length) segs.push(tokens); tokens = []; };
  for (const c of command) {
    // A newline ends the segment *and* any open quote. Quote state must not
    // cross a line: an apostrophe in prose ("the daemon's timer") otherwise
    // opens a quote that never closes and swallows every command after it —
    // it cost segments in 34% of this corpus's multi-line commands.
    if (c === "\n") { endSegment(); quote = null; continue; }
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === "|" || c === ";" || c === "&" || c === "(" || c === ")" || c === "`") {
      // A command substitution contains a real command. `out=$(gh pr checks 1)`
      // otherwise matched the env-assignment skip on `out=$(gh`, consuming the
      // command name and leaving `pr` as the executable.
      endSegment();
    } else if (/\s/.test(c)) {
      endToken();
    } else {
      cur += c;
    }
  }
  endSegment();
  return segs;
}

/** What one segment invokes, or null when it invokes nothing nameable. */
function classify(tokens: string[]): Invocation | null {
  let i = 0;
  for (;;) {
    // Env assignments and wrappers delegate rightwards.
    while (i < tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!) || WRAPPERS.has(tokens[i]!))) i++;
    const delegate = DELEGATORS[tokens[i] ?? ""];
    if (delegate && tokens[i + 1] === delegate) { i += 2; continue; }
    // An option here belongs to whatever was skipped, not to the tool.
    const t = tokens[i];
    if (t?.startsWith("-")) { i += VALUE_FLAGS.has(t) ? 2 : 1; continue; }
    break;
  }
  const exe = tokens[i]?.split("/").pop();
  // A path-only token ("//", "./") leaves nothing nameable behind.
  if (!exe) return null;

  const flags: string[] = [];
  let sub: string | undefined;
  for (let j = i + 1; j < tokens.length; j++) {
    const t = tokens[j]!;
    if (t.startsWith("-")) {
      flags.push(t.split("=")[0]!);
      if (VALUE_FLAGS.has(t)) j++;
    } else if (sub === undefined) {
      sub = t;
    }
  }
  return { exe, sub, flags };
}

/**
 * What a command line invokes — one entry per pipeline or compound segment,
 * with arguments ignored by construction.
 *
 * This is deliberately a second implementation of the same idea as the
 * benchmark's `bench/ground-truth.mjs`. Sharing one parser would let a single
 * bug decide both the product's answer and the answer key it is graded
 * against — which is how the original defect survived here: the two differed
 * only because the key was rewritten, and that difference is what exposed it.
 */
export function invocations(command: string): Invocation[] {
  return segments(stripHeredocBodies(command)).map(classify).filter((x): x is Invocation => x !== null);
}

/**
 * The executables the rule table covers. Exported so the benchmark can label
 * which of its questions fall outside what this file can see at all — a score
 * built only from questions we already model reports nothing about coverage.
 */
/** Every tool label the rule table can name, with the family it competes in — the vocabulary an answer is checked against. */
export function toolFamilies(): { label: string; family: string }[] {
  const seen = new Set<string>();
  return RULES.filter((r) => !seen.has(r.label) && seen.add(r.label)).map((r) => ({ label: r.label, family: r.family }));
}

export function modelledExecutables(): Set<string> {
  return new Set(RULES.map((r) => r.exe));
}

// A handful of uses is noise (one-off experiment, a suggestion the user
// rejected); a habit shows up repeatedly.
const MIN_USES = 3;
// Within a family, a tool has to clearly lead before we call it a preference.
const DOMINANCE = 2;
// What a contested family is served at: below the ask threshold, so an answer
// resting on it defers to the human instead of picking a side.
const CONTESTED_CONFIDENCE = 0.5;

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
        if (inv.exe === rule.exe
          && (rule.sub === undefined || inv.sub === rule.sub)
          && (rule.flag === undefined || inv.flags.includes(rule.flag))) {
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
    // A contested family: the user demonstrably uses both, so a preference
    // either way would be wrong. Silence is worse, though — an empty family let
    // a stale prose claim ("prefers pnpm") answer for the project in its place.
    // Serve the fact with both counts and a confidence that reads as "ask".
    if (runnerUp && top.n < runnerUp.n * DOMINANCE) {
      signals.push({
        dimension: top.rule.dimension,
        pattern: `uses both ${top.rule.label} (${top.n}) and ${runnerUp.rule.label} (${runnerUp.n}) — no clear preference`,
        polarity: "does",
        confidence: CONTESTED_CONFIDENCE,
        // No "N command(s)" phrasing on purpose: statedConvention() would read
        // it back as a single count for a pattern that carries two.
        evidence: `no clear leader across sessions: ${top.rule.label} ${top.n}, ${runnerUp.rule.label} ${runnerUp.n} invocations`,
        basis: "stylometry",
      });
      continue;
    }

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
