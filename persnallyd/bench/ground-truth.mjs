/**
 * Ground truth for the person-model benchmark, computed from raw evidence.
 *
 * Deliberately independent of `src/workflow.ts`: if the product's derivation and
 * the answer key shared code, a bug in the derivation would score itself
 * correct. This counts tool invocations straight out of the transcripts and
 * nothing else.
 *
 * Questions are emitted as **contrastive pairs** — the same question against two
 * projects whose answers differ. That is not a stylistic choice. Measured on a
 * real store, a model that knows nothing scores 75% on singleton questions by
 * always guessing the family's popular default, and "which search tool" is 100%
 * guessable. On pairs, a guesser scores 0%: it gets exactly one half right, and
 * a pair only counts when both halves are.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

/**
 * Competing tools, matched against the **executable being invoked** — never the
 * whole command string. `rg pnpm package.json` runs ripgrep and mentions pnpm;
 * substring matching counted it as pnpm usage and corrupted the answer key.
 * A wrong answer key is the worst defect a benchmark can have: the flagship
 * long-term-memory benchmark ships with 6.4% of its goldens wrong, and grading
 * a correct product answer against a bad key is indistinguishable from a
 * product bug.
 *
 * Each entry is [executable, subcommand or null, label].
 */
const FAMILIES = {
  "package manager": [["pnpm", null, "pnpm"], ["npm", null, "npm"], ["yarn", null, "yarn"], ["bun", null, "bun"]],
  "git integration": [["git", "rebase", "rebase"], ["git", "merge", "merge"]],
  "test runner": [["vitest", null, "vitest"], ["jest", null, "jest"], ["pytest", null, "pytest"], ["go", "test", "go test"]],
  "search tool": [["rg", null, "ripgrep"], ["grep", null, "grep"]],
};

/** Wrappers that delegate to the tool that follows them. */
const WRAPPERS = new Set(["sudo", "time", "env", "npx", "bunx", "command", "nohup", "xargs"]);

/**
 * Runners that delegate only in front of a specific token: `python -m pytest`
 * invokes pytest, `python script.py` invokes python. Without this, every
 * `python -m pytest` and `uv run pytest` reads as a Python invocation and the
 * project loses its test runner.
 */
const DELEGATORS = { python: "-m", python3: "-m", uv: "run", poetry: "run", pipenv: "run", pdm: "run" };

/**
 * The (executable, subcommand) pairs a command line actually invokes — one per
 * pipeline or compound segment. Arguments are ignored by construction, which is
 * the whole point.
 */
export function invocations(command) {
  const out = [];
  for (const seg of command.split(/\|\||&&|[|;&\n]/)) {
    const tokens = seg.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    for (;;) {
      // Leading env assignments (FOO=bar cmd) and wrappers delegate rightwards.
      while (i < tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]) || WRAPPERS.has(tokens[i]))) i++;
      const d = DELEGATORS[tokens[i]];
      if (d && tokens[i + 1] === d) { i += 2; continue; }
      break;
    }
    const exe = tokens[i];
    if (!exe) continue;
    const base = exe.split("/").pop();
    // The first token that is not a flag is the subcommand.
    const sub = tokens.slice(i + 1).find((t) => !t.startsWith("-"));
    out.push({ exe: base, sub });
  }
  return out;
}

/** Below this, the "winner" is noise rather than a habit. */
const MIN_EVIDENCE = 10;
/** The leader must clear the runner-up by this much, or the answer is genuinely ambiguous. */
const DOMINANCE = 3;

/** Every Bash command run in a project, straight from the Claude Code transcripts. */
export function commandsByProject(root = join(homedir(), ".claude", "projects")) {
  const per = new Map();
  for (const entry of readdirSync(root)) {
    const dir = join(root, entry);
    if (!statSync(dir).isDirectory()) continue;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".jsonl")) continue;
      let cwd = "";
      const cmds = [];
      for (const line of readFileSync(join(dir, file), "utf8").split("\n")) {
        if (!line.trim()) continue;
        let e;
        try { e = JSON.parse(line); } catch { continue; }
        if (!cwd && typeof e.cwd === "string") cwd = e.cwd;
        for (const b of Array.isArray(e.message?.content) ? e.message.content : []) {
          if (b?.type === "tool_use" && b?.name === "Bash" && typeof b?.input?.command === "string") {
            cmds.push(b.input.command);
          }
        }
      }
      const key = cwd || entry;
      per.set(key, [...(per.get(key) ?? []), ...cmds]);
    }
  }
  return per;
}

/** The one defensible answer for a family in a project, or null when there isn't one. */
function decide(cmds, rules) {
  const invs = cmds.flatMap(invocations);
  const counts = rules
    .map(([exe, sub, label]) => ({
      label,
      n: invs.filter((i) => i.exe === exe && (sub === null || i.sub === sub)).length,
    }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n);
  const top = counts[0];
  if (!top || top.n < MIN_EVIDENCE) return null;
  if (counts[1] && top.n < counts[1].n * DOMINANCE) return null; // genuinely uses both
  return { answer: top.label, evidence: top.n, runnerUp: counts[1] ?? null };
}

/**
 * Contrastive pairs, plus the closed answer set each question is graded against.
 * A family where every project answers the same is excluded: it carries no
 * information about this person, only about the popularity of the tool.
 */
export function buildPairs(root) {
  const per = commandsByProject(root);
  const answers = new Map(); // family -> [{ project, label, answer, evidence }]

  for (const [family, rules] of Object.entries(FAMILIES)) {
    const found = [];
    for (const [project, cmds] of per) {
      const d = decide(cmds, rules);
      if (d) found.push({ project, label: basename(project) || project, ...d });
    }
    if (new Set(found.map((f) => f.answer)).size > 1) answers.set(family, found);
  }

  const pairs = [];
  for (const [family, found] of answers) {
    const options = FAMILIES[family].map(([, , l]) => l);
    for (let i = 0; i < found.length; i++) {
      for (let j = i + 1; j < found.length; j++) {
        if (found[i].answer === found[j].answer) continue;
        pairs.push({ family, options, a: found[i], b: found[j] });
      }
    }
  }
  return { pairs, answers, excluded: Object.keys(FAMILIES).filter((f) => !answers.has(f)) };
}

/**
 * What a model that knows nothing scores on the singleton questions, by always
 * naming the family's most common answer. Reported alongside every result so a
 * raw accuracy figure can never be mistaken for evidence of knowledge.
 */
export function majorityBaseline(answers) {
  let total = 0, correct = 0;
  for (const found of answers.values()) {
    const counts = new Map();
    for (const f of found) counts.set(f.answer, (counts.get(f.answer) ?? 0) + 1);
    const best = Math.max(...counts.values());
    total += found.length;
    correct += best;
  }
  return { total, correct, rate: total ? correct / total : 0 };
}
