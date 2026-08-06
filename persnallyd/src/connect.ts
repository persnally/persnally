/**
 * Writes the Persnally MCP server into AI clients' configs.
 * Only touches clients that are actually installed; merges, never clobbers.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ensurePrivateFile, FILE_MODE } from "./paths.js";
import { issueToken } from "./permissions.js";

export const CLIENTS = ["claude-code", "claude-desktop", "cursor"] as const;
export type Client = (typeof CLIENTS)[number];

/**
 * Write JSON via temp file + rename: a crash mid-write can't corrupt the user's
 * config. The temp file is created owner-only because we are about to write a
 * bearer token into it — and because rename replaces the destination's mode
 * with the temp file's, so anything looser here would silently downgrade a
 * config the user had already restricted.
 */
function writeJsonAtomic(file: string, cfg: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", { mode: FILE_MODE });
  renameSync(tmp, file);
  ensurePrivateFile(file);
}

function configPathFor(client: Client): { file: string; installed: boolean } {
  const home = homedir();
  switch (client) {
    case "claude-code": {
      const file = join(home, ".claude.json");
      return { file, installed: existsSync(file) || existsSync(join(home, ".claude")) };
    }
    case "claude-desktop": {
      const dir = join(home, "Library", "Application Support", "Claude");
      return { file: join(dir, "claude_desktop_config.json"), installed: existsSync(dir) };
    }
    case "cursor": {
      const dir = join(home, ".cursor");
      return { file: join(dir, "mcp.json"), installed: existsSync(dir) };
    }
  }
}

export function mcpServerPath(): string {
  if (process.env.PERSNALLY_MCP && existsSync(process.env.PERSNALLY_MCP)) return process.env.PERSNALLY_MCP;
  // Bundled in this package: build/src/connect.js → build/src/mcp/index.js
  const bundled = join(import.meta.dirname, "mcp", "index.js");
  if (existsSync(bundled)) return bundled;
  throw new Error("Persnally MCP server build not found — set PERSNALLY_MCP to its index.js");
}

/** Returns the config file written, or null when the client isn't installed. */
export function connectClient(client: Client): string | null {
  const { file, installed } = configPathFor(client);
  if (!installed) return null;
  let cfg: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      cfg = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
    } catch {
      // Never overwrite a config we couldn't parse — that would wipe the user's
      // other MCP servers. Surface it instead.
      throw new Error(`${file} is not valid JSON — fix it, then run \`persnallyd connect ${client}\` again`);
    }
  }
  const servers = (cfg.mcpServers ??= {}) as Record<string, unknown>;
  // Each connect mints (or rotates) this client's identity token — the daemon
  // then refuses this client name without it, so scopes/revocations can't be
  // bypassed by a client claiming someone else's name.
  servers.persnally = {
    command: "node",
    args: [mcpServerPath()],
    env: { PERSNALLY_CLIENT: client, PERSNALLY_CLIENT_TOKEN: issueToken(client) },
  };
  writeJsonAtomic(file, cfg);
  return file;
}

// The hook self-renders the SessionStart envelope (`context --hook`), so no jq dependency.
const SESSION_START_COMMAND = "persnallyd context --hook 2>/dev/null";

interface HookEntry { type?: string; command?: string; timeout?: number; statusMessage?: string }
interface HookGroup { hooks?: HookEntry[] }

/**
 * Installs (or upgrades) the Persnally SessionStart hook in Claude Code's user
 * settings so every session injects the user's context. Merges into existing
 * settings, leaves other tools' hooks untouched, and is idempotent: a prior
 * Persnally entry (including the old `show topics` form) is replaced, not duplicated.
 */
export function installClaudeCodeHook(): string {
  const file = join(homedir(), ".claude", "settings.json");
  let cfg: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      cfg = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
    } catch {
      throw new Error(`${file} is not valid JSON — fix it, then run \`persnallyd connect claude-code\` again`);
    }
  }
  const hooks = (cfg.hooks ??= {}) as Record<string, unknown>;
  const existing = Array.isArray(hooks.SessionStart) ? (hooks.SessionStart as HookGroup[]) : [];
  const others = existing.filter((g) => !g.hooks?.some((h) => /persnall/i.test(h.command ?? "")));
  others.push({
    hooks: [{ type: "command", command: SESSION_START_COMMAND, timeout: 10, statusMessage: "Loading your Persnally context…" }],
  });
  hooks.SessionStart = others;
  writeJsonAtomic(file, cfg);
  return file;
}

export function connectAll(): { client: Client; file: string | null }[] {
  // One client with a malformed existing config must not abort onboarding for
  // the others; connectClient throws rather than clobber a file it can't parse.
  return CLIENTS.map((client) => {
    try {
      return { client, file: connectClient(client) };
    } catch {
      return { client, file: null };
    }
  });
}
