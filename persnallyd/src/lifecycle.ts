/**
 * Daemon lifecycle — pidfile, detached start/stop, and login autostart
 * (macOS launchd · Linux systemd user unit).
 * The pidfile is advisory: a stale one (dead pid) is detected and cleaned up.
 */

import { execFileSync, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DATA_DIR, ensurePrivateDir, ensurePrivateFile } from "./paths.js";

const PID_FILE = join(DATA_DIR, "daemon.pid");
export const LOG_FILE = join(DATA_DIR, "daemon.log");
const PLIST_LABEL = "com.persnally.daemon";
const PLIST_PATH = join(homedir(), "Library", "LaunchAgents", `${PLIST_LABEL}.plist`);
const UNIT_NAME = "persnally.service";

// Resolved at call time so XDG_CONFIG_HOME overrides work in-process (tests).
function unitPath(): string {
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "systemd", "user", UNIT_NAME);
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Returns the running daemon's pid, cleaning up a stale pidfile if found. */
export function runningPid(): number | null {
  if (!existsSync(PID_FILE)) return null;
  const pid = Number(readFileSync(PID_FILE, "utf-8").trim());
  if (Number.isInteger(pid) && pid > 0 && alive(pid)) return pid;
  unlinkSync(PID_FILE);
  return null;
}

export function writePidFile(): void {
  ensurePrivateDir(DATA_DIR);
  writeFileSync(PID_FILE, String(process.pid));
}

export function removePidFile(): void {
  try {
    if (Number(readFileSync(PID_FILE, "utf-8").trim()) === process.pid) unlinkSync(PID_FILE);
  } catch { /* already gone */ }
}

export async function startDetached(cliPath: string, port: number): Promise<number> {
  ensurePrivateDir(DATA_DIR);
  // stdout/stderr of the daemon: import paths, topic names on error.
  const log = openSync(LOG_FILE, "a", 0o600);
  ensurePrivateFile(LOG_FILE);
  const child = spawn(process.execPath, [cliPath, "serve", "--port", String(port)], {
    detached: true,
    stdio: ["ignore", log, log],
    env: process.env,
  });
  closeSync(log); // the child dup'd it at spawn; don't leak the parent's copy
  child.unref();

  for (let i = 0; i < 30; i++) {
    await sleep(100);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) return child.pid!;
    } catch { /* not up yet */ }
  }
  throw new Error(`daemon did not become healthy — check ${LOG_FILE}`);
}

export async function stopDaemon(): Promise<number | null> {
  const pid = runningPid();
  if (!pid) return null;
  process.kill(pid, "SIGTERM");
  for (let i = 0; i < 50; i++) {
    await sleep(100);
    if (!alive(pid)) return pid;
  }
  throw new Error(`daemon (pid ${pid}) did not exit within 5s`);
}

export function autostartInstalled(): boolean {
  if (process.platform === "darwin") return existsSync(PLIST_PATH);
  if (process.platform === "linux") return existsSync(unitPath());
  return false;
}

export function installAutostart(cliPath: string, port: number): string {
  if (process.platform === "darwin") return installLaunchd(cliPath, port);
  if (process.platform === "linux") return installSystemd(cliPath, port);
  throw new Error("autostart is supported on macOS (launchd) and Linux (systemd) — on this platform use `persnallyd start`");
}

function installLaunchd(cliPath: string, port: number): string {
  // Paths carry the username/home dir; escape so an "&" or "<" in a path can't
  // produce a malformed plist that silently breaks autostart.
  const x = xmlEscape;
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${x(process.execPath)}</string>
    <string>${x(cliPath)}</string>
    <string>serve</string>
    <string>--port</string>
    <string>${x(String(port))}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${x(LOG_FILE)}</string>
  <key>StandardErrorPath</key><string>${x(LOG_FILE)}</string>
</dict>
</plist>
`;
  mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
  writeFileSync(PLIST_PATH, plist);
  execFileSync("launchctl", ["load", "-w", PLIST_PATH]);
  return PLIST_PATH;
}

/** The systemd user unit, rendered for one install. Exported for tests. */
export function renderSystemdUnit(cliPath: string, port: number): string {
  // systemd unit quoting: double-quote each arg; escape backslash and quote
  // (C-style) so a pathological path can't break out of its quotes.
  const q = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  return `[Unit]
Description=Persnally — local personal context engine
After=default.target

[Service]
ExecStart=${q(process.execPath)} ${q(cliPath)} serve --port ${port}
Restart=always
RestartSec=2
StandardOutput=append:${LOG_FILE}
StandardError=append:${LOG_FILE}

[Install]
WantedBy=default.target
`;
}

function installSystemd(cliPath: string, port: number): string {
  const path = unitPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, renderSystemdUnit(cliPath, port));
  try {
    execFileSync("systemctl", ["--user", "daemon-reload"]);
    execFileSync("systemctl", ["--user", "enable", "--now", UNIT_NAME]);
  } catch (e) {
    // Don't leave a half-installed unit that autostartInstalled() would report as live.
    rmSync(path, { force: true });
    throw new Error(
      `systemd user service could not be enabled (${e instanceof Error ? e.message : e}) — ` +
      "is this a systemd distro with a user session? Fallback: `persnallyd start`.",
    );
  }
  return path;
}

export function removeAutostart(): boolean {
  if (process.platform === "linux") {
    if (!existsSync(unitPath())) return false;
    try { execFileSync("systemctl", ["--user", "disable", "--now", UNIT_NAME]); } catch { /* not enabled */ }
    rmSync(unitPath(), { force: true });
    try { execFileSync("systemctl", ["--user", "daemon-reload"]); } catch { /* best effort */ }
    return true;
  }
  if (!existsSync(PLIST_PATH)) return false;
  try { execFileSync("launchctl", ["unload", "-w", PLIST_PATH]); } catch { /* not loaded */ }
  rmSync(PLIST_PATH);
  return true;
}

/**
 * Reload the launchd job so the daemon restarts on the currently-installed build.
 * `unload` then `load` — a plain `load` can't replace an already-loaded job, which
 * is how a plist path silently drifts from the running process. Rewriting from the
 * caller's cliPath also heals that drift. Returns the new daemon's /health once it
 * answers, or null if it didn't come up in time.
 */
export async function reloadAutostart(cliPath: string, port: number): Promise<{ version: string } | null> {
  removeAutostart();
  installAutostart(cliPath, port);
  for (let i = 0; i < 30; i++) {
    await sleep(100);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) return (await r.json()) as { version: string };
    } catch { /* launchd hasn't brought it up yet */ }
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function xmlEscape(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]!));
}
