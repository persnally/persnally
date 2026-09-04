/**
 * Health checks for an install that is meant to be invisible.
 *
 * Being invisible after day one is the design goal; the cost is that breakage
 * is invisible too. Three real incidents drove this: a CLI whose executable bit
 * was lost (every command died with EACCES), a daemon left on 2.10.0 for a day
 * after 3.0.0 shipped (so none of that release's security fixes were running),
 * and live capture that stopped for two days without a single signal anywhere.
 * None of them announced themselves; all of them silently stop the retention
 * loop the roadmap gates on.
 *
 * Checks are pure functions over injected Facts so every branch — including the
 * ones that need a broken machine — is testable.
 */

import { accessSync, constants, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

export type Level = "ok" | "warn" | "fail";

export interface Check {
  id: string;
  level: Level;
  title: string;
  detail: string;
  /** A command or action that resolves it. Omitted when nothing is wrong. */
  fix?: string;
}

export interface BinFact {
  name: string;
  path: string | null;
  executable: boolean;
}

/** Everything the checks need, gathered separately so they stay pure. */
export interface Facts {
  cliVersion: string;
  /** null when the daemon is unreachable. */
  daemonVersion: string | null;
  daemonPid: number | null;
  autostartInstalled: boolean;
  bins: BinFact[];
  /** Last context.read — the heartbeat of live serving (hook + MCP). */
  lastReadAt: string | null;
  /** Newest Claude Code transcript mtime; null when none exist. */
  newestSessionAt: string | null;
  /** The SessionStart command referencing Persnally, if installed. */
  hookCommand: string | null;
  /** Extraction engine available for conversation imports. */
  hasEngine: boolean;
  now: number;
  platform: NodeJS.Platform;
}

const DAY = 86_400_000;
const ok = (id: string, title: string, detail: string): Check => ({ id, level: "ok", title, detail });

/**
 * A daemon on an older build than the CLI is the quiet one: every command still
 * works, and the fixes shipped in the newer version simply are not running.
 */
export function checkDaemon(f: Facts): Check {
  if (f.daemonVersion === null) {
    return {
      id: "daemon", level: "fail", title: "Daemon not running",
      detail: f.autostartInstalled
        ? "Autostart is installed but nothing is listening — the supervisor did not bring it back."
        : "Nothing is serving context; connected AIs get nothing.",
      fix: "persnally start",
    };
  }
  if (f.daemonVersion !== f.cliVersion) {
    return {
      id: "daemon", level: "fail", title: `Daemon is running ${f.daemonVersion}, CLI is ${f.cliVersion}`,
      detail: "An upgrade landed on disk but the running process is the old build, so its fixes are not active.",
      fix: "persnally restart",
    };
  }
  return ok("daemon", `Daemon healthy (${f.daemonVersion})`, `pid ${f.daemonPid ?? "?"}`);
}

/** An install whose bins lost their executable bit fails with EACCES on every command. */
export function checkBins(f: Facts): Check {
  const missing = f.bins.filter((b) => !b.path);
  if (missing.length) {
    return {
      id: "bins", level: "fail", title: `Not on PATH: ${missing.map((b) => b.name).join(", ")}`,
      detail: "MCP clients launch these by name; a client cannot start a binary it cannot resolve.",
      fix: "npm install -g persnally",
    };
  }
  // Windows has no executable bit; the check would always pass and mean nothing.
  const broken = f.platform === "win32" ? [] : f.bins.filter((b) => !b.executable);
  if (broken.length) {
    return {
      id: "bins", level: "fail", title: `Not executable: ${broken.map((b) => b.name).join(", ")}`,
      detail: "Every invocation fails with 'permission denied', including the MCP server your clients spawn.",
      fix: `chmod +x ${broken.map((b) => b.path).join(" ")}`,
    };
  }
  return ok("bins", `All ${f.bins.length} binaries resolve`, f.bins.map((b) => b.name).join(", "));
}

/**
 * The heartbeat. Claude Code sessions on disk that are newer than the last
 * context read mean the sessions happened and Persnally served none of them —
 * exactly the failure that ran silently for two days.
 */
export function checkCapture(f: Facts): Check {
  if (!f.newestSessionAt) {
    return ok("capture", "No Claude Code sessions to serve", "Nothing to compare against yet.");
  }
  const session = Date.parse(f.newestSessionAt);
  const read = f.lastReadAt ? Date.parse(f.lastReadAt) : null;
  const staleBy = read === null ? Infinity : session - read;
  const sessionAge = Math.floor((f.now - session) / DAY);

  if (read === null) {
    return {
      id: "capture", level: "fail", title: "Never served context to a session",
      detail: "Claude Code transcripts exist but no context read was ever recorded.",
      fix: "persnally connect claude-code",
    };
  }
  if (staleBy >= 2 * DAY) {
    return {
      id: "capture", level: "fail", title: `Capture stopped ${Math.floor(staleBy / DAY)} day(s) before your last session`,
      detail: `Newest session ${sessionAge}d ago, last context read ${f.lastReadAt}. Sessions ran and got nothing.`,
      fix: "persnally connect claude-code && persnally restart",
    };
  }
  return ok("capture", "Live capture current", `Last read ${f.lastReadAt}`);
}

/** Without the hook, context is served only when a tool explicitly asks. */
export function checkHook(f: Facts): Check {
  if (!f.hookCommand) {
    return {
      id: "hook", level: "warn", title: "Claude Code SessionStart hook not installed",
      detail: "Context is not injected automatically; sessions start cold unless the AI calls a tool.",
      fix: "persnally connect claude-code",
    };
  }
  return ok("hook", "SessionStart hook installed", f.hookCommand);
}

/** No engine is a legitimate state (git import is offline) — but it silently halves the mirror. */
export function checkEngine(f: Facts): Check {
  if (!f.hasEngine) {
    return {
      id: "engine", level: "warn", title: "No extraction engine",
      detail: "Conversation imports are skipped without one; git and voice still work offline.",
      fix: "ollama pull llama3.1  (or: persnally config set-key sk-ant-…)",
    };
  }
  return ok("engine", "Extraction engine available", "Conversation imports can run.");
}

export function runChecks(f: Facts): Check[] {
  return [checkBins(f), checkDaemon(f), checkCapture(f), checkHook(f), checkEngine(f)];
}

/** Worst level present — the process exit code follows this. */
export function worst(checks: Check[]): Level {
  if (checks.some((c) => c.level === "fail")) return "fail";
  if (checks.some((c) => c.level === "warn")) return "warn";
  return "ok";
}

// ── gathering real state ─────────────────────────────────────────────────────

/** First match for `name` on PATH, with whether it is executable. */
export function resolveBin(name: string, pathEnv = process.env.PATH ?? ""): BinFact {
  for (const dir of pathEnv.split(delimiter).filter(Boolean)) {
    const candidate = join(dir, name);
    if (!existsSync(candidate)) continue;
    let executable = false;
    try {
      accessSync(candidate, constants.X_OK);
      executable = true;
    } catch { /* resolves but cannot be run — precisely what this reports */ }
    return { name, path: candidate, executable };
  }
  return { name, path: null, executable: false };
}

/** Mtime of the most recently written Claude Code transcript. */
export function newestSession(dir: string): string | null {
  if (!existsSync(dir)) return null;
  let newest = 0;
  for (const project of readdirSync(dir, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const projectDir = join(dir, project.name);
    let files: string[];
    try { files = readdirSync(projectDir); } catch { continue; }
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      try {
        const m = statSync(join(projectDir, file)).mtimeMs;
        if (m > newest) newest = m;
      } catch { /* vanished mid-scan */ }
    }
  }
  return newest ? new Date(newest).toISOString() : null;
}

/** The installed SessionStart command that mentions Persnally, if any. */
export function installedHook(settingsFile = join(homedir(), ".claude", "settings.json")): string | null {
  if (!existsSync(settingsFile)) return null;
  let cfg: { hooks?: { SessionStart?: { hooks?: { command?: string }[] }[] } };
  // A settings file we cannot parse is the user's to fix; report "no hook"
  // rather than throwing out of a diagnostic command.
  try { cfg = JSON.parse(readFileSync(settingsFile, "utf-8")); } catch { return null; }
  for (const group of cfg.hooks?.SessionStart ?? []) {
    for (const h of group.hooks ?? []) {
      if (h.command && /persnall/i.test(h.command)) return h.command;
    }
  }
  return null;
}

export function render(checks: Check[]): string {
  const mark = { ok: "✓", warn: "!", fail: "✗" } as const;
  const lines: string[] = [];
  for (const c of checks) {
    lines.push(`${mark[c.level]} ${c.title}`);
    lines.push(`    ${c.detail}`);
    if (c.fix) lines.push(`    → ${c.fix}`);
  }
  const level = worst(checks);
  lines.push("");
  lines.push(level === "ok" ? "Everything is healthy."
    : level === "warn" ? "Working, with warnings above."
    : "Something is broken — see ✗ above.");
  return lines.join("\n");
}
