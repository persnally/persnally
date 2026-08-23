/**
 * Questions derived from the corpus instead of from our own rule table.
 *
 * The family questions in `ground-truth.mjs` can only ask about tools
 * `src/workflow.ts` already models, so the benchmark is structurally blind to
 * exactly the gaps worth finding: a tool the product cannot see is also a tool
 * the benchmark never asks about (#235). A score built only from those questions
 * measures precision inside what we chose to model and silently reports nothing
 * about coverage.
 *
 * These questions need no family. For a pair of projects, find a tool used
 * heavily in one and essentially absent from the other, and ask which of the two
 * this project uses. The answer is decided by counting invocations, the option
 * set is closed (two tools), and — crucially — neither tool has to be modelled.
 * A question the product is guaranteed to fail is the one worth asking.
 */

import { readdirSync } from "node:fs";
import { basename } from "node:path";

import { invocations } from "./ground-truth.mjs";

/**
 * Shell builtins, coreutils and interpreters. Not "tools we failed to model" —
 * running `cat` expresses no preference and belongs in no answer set.
 */
const NOISE = new Set([
  "echo", "cd", "ls", "cat", "head", "tail", "sed", "awk", "sort", "uniq", "wc", "cp", "mv", "rm",
  "mkdir", "rmdir", "touch", "chmod", "chown", "ln", "which", "pwd", "export", "source", "set",
  "unset", "read", "printf", "tr", "cut", "paste", "join", "xargs", "sleep", "kill", "pkill",
  "ps", "top", "open", "curl", "wget", "date", "env", "true", "false", "test", "basename",
  "dirname", "tee", "diff", "patch", "tar", "zip", "unzip", "gzip", "sudo", "time", "watch",
  "lsof", "ssh", "scp", "rsync", "nc", "dig", "ping", "host", "whoami", "id", "du", "df",
  "node", "python", "python3", "ruby", "perl", "bash", "sh", "zsh", "npx", "uv", "deno", "bun",
  "for", "do", "done", "if", "then", "else", "elif", "fi", "while", "until", "case", "esac",
  "function", "return", "local", "eval", "exit", "trap", "wait", "type", "command", "exec",
  "break", "continue", "shift", "declare", "typeset", "alias", "history", "jobs", "fg", "bg",
  "timeout", "comm", "split", "expand", "fold", "nl", "od", "seq", "yes", "printenv", "stat",
  "realpath", "readlink", "mktemp", "install", "strings", "file", "less", "more", "man",
]);

/** A token that could plausibly name a tool, rather than parse debris. */
const PLAUSIBLE = /^[a-z][a-z0-9._+-]{1,20}$/;

/**
 * Executables that exist on this machine.
 *
 * The filter has to come from somewhere other than our own rule table, or the
 * subset problem this module exists to break comes straight back. PATH is that
 * somewhere: `cargo`, `ruff` and `xcodebuild` are installed programs, while
 * `const`, `wq` and `import` — debris from code and prose that reached the
 * command log — are not. Imperfect (a tool used last year may since have been
 * uninstalled) but independent of what we chose to model.
 */
function executablesOnPath() {
  const names = new Set();
  for (const dir of (process.env.PATH ?? "").split(":")) {
    try {
      for (const entry of readdirSync(dir)) names.add(entry);
    } catch {
      // A PATH entry that does not exist is normal, not an error.
    }
  }
  return names;
}

/** Used this much in a project to count as "uses it". */
const PRESENT = 10;
/** At most this much in the other project to count as "does not use it". */
const ABSENT = 2;

/** True when the tool's name gives the answer away from the project name. */
function nameLeaks(tool, project) {
  const name = basename(project).toLowerCase();
  return name.includes(tool.toLowerCase()) || tool.toLowerCase().includes(name);
}

/** Invocation counts per executable for one project's commands. */
function toolCounts(commands) {
  const counts = new Map();
  for (const command of commands) {
    for (const { exe } of invocations(command)) {
      if (NOISE.has(exe) || !PLAUSIBLE.test(exe)) continue;
      counts.set(exe, (counts.get(exe) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * Contrastive pairs over any tool in the corpus.
 *
 * `limitPerPair` caps how many questions one project pair contributes, so a
 * project with a large toolchain cannot dominate the set. The cap is reported
 * rather than applied silently.
 */
export function corpusPairs(commandsByProject, { limitPerPair = 2, modelled = new Set() } = {}) {
  const projects = [...commandsByProject].filter(([, cmds]) => cmds.length);
  const real = executablesOnPath();
  const counts = new Map(projects.map(([p, cmds]) => [
    p,
    new Map([...toolCounts(cmds)].filter(([tool]) => real.has(tool))),
  ]));

  const pairs = [];
  let dropped = 0;
  for (let i = 0; i < projects.length; i++) {
    for (let j = i + 1; j < projects.length; j++) {
      const [pa] = projects[i], [pb] = projects[j];
      const ca = counts.get(pa), cb = counts.get(pb);

      // Tools that separate the two projects, strongest evidence first.
      // A tool named after its own project ("persnally" in persnally) is
      // answerable from the question text alone, which is exactly the guessing
      // the pair structure exists to defeat.
      const separates = (own, other, project) => [...own]
        .filter(([t, n]) => n >= PRESENT && (other.get(t) ?? 0) <= ABSENT && !nameLeaks(t, project))
        .sort((x, y) => y[1] - x[1]);
      const onlyA = separates(ca, cb, pa);
      const onlyB = separates(cb, ca, pb);

      const candidates = [];
      for (let k = 0; k < Math.min(onlyA.length, onlyB.length); k++) {
        const [ta, na] = onlyA[k], [tb, nb] = onlyB[k];
        candidates.push({
          family: "tool in this workspace",
          options: [ta, tb],
          // The point of the exercise: a question whose options the rule table
          // cannot see is one the product must fail, and the family questions
          // can never pose it.
          blindSpot: !modelled.has(ta) || !modelled.has(tb),
          a: { project: pa, answer: ta, evidence: na },
          b: { project: pb, answer: tb, evidence: nb },
        });
      }

      // Blind spots first, then strongest evidence. Ordering by evidence alone
      // filled the cap with the busiest tools — the ones we already model — and
      // dropped every question that could have revealed a gap.
      candidates.sort((x, y) =>
        (y.blindSpot ? 1 : 0) - (x.blindSpot ? 1 : 0)
        || Math.min(y.a.evidence, y.b.evidence) - Math.min(x.a.evidence, x.b.evidence));

      if (candidates.length > limitPerPair) dropped += candidates.length - limitPerPair;
      pairs.push(...candidates.slice(0, limitPerPair));
    }
  }
  return { pairs, dropped };
}
