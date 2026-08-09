/**
 * Writes the Persnally MCP server into AI clients' configs.
 * Only touches clients that are actually installed; merges, never clobbers.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ensurePrivateFile, FILE_MODE } from "./paths.js";
import { issueToken } from "./permissions.js";

export const CLIENTS = [
  "claude-code", "claude-desktop", "cursor",
  "codex", "gemini-cli", "windsurf", "zed", "vscode",
] as const;
export type Client = (typeof CLIENTS)[number];

/**
 * Where each client's MCP entry lives. They agree on stdio and disagree on
 * everything else, so the shape is explicit per client rather than assumed:
 *
 *   mcpServers      { command, args, env }                  Claude*, Cursor, Windsurf, Gemini CLI
 *   context_servers { command: { path, args, env } }        Zed — command is an object
 *   servers         { type: "stdio", command, args, env }   VS Code — type is required
 *   toml            [mcp_servers.persnally]                 Codex — TOML, not JSON
 */
type Shape = "mcpServers" | "context_servers" | "servers" | "toml";

/**
 * Write JSON via temp file + rename: a crash mid-write can't corrupt the user's
 * config. The temp file is created owner-only because we are about to write a
 * bearer token into it — and because rename replaces the destination's mode
 * with the temp file's, so anything looser here would silently downgrade a
 * config the user had already restricted.
 */
function writeTextAtomic(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: FILE_MODE });
  renameSync(tmp, file);
  ensurePrivateFile(file);
}

function writeJsonAtomic(file: string, cfg: unknown): void {
  writeTextAtomic(file, JSON.stringify(cfg, null, 2) + "\n");
}

/** Basic TOML string. Our values are paths and tokens — no control characters. */
function tomlString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function codexBlock(serverPath: string, client: Client, token: string): string {
  return [
    "[mcp_servers.persnally]",
    `command = ${tomlString("node")}`,
    `args = [${tomlString(serverPath)}]`,
    "",
    "[mcp_servers.persnally.env]",
    `PERSNALLY_CLIENT = ${tomlString(client)}`,
    `PERSNALLY_CLIENT_TOKEN = ${tomlString(token)}`,
  ].join("\n");
}

/**
 * Splices our table into Codex's TOML without parsing it. Adding a TOML parser
 * to write four lines is not worth the dependency, and a round-trip through one
 * would reformat the user's file and drop their comments.
 *
 * Instead: drop any existing `[mcp_servers.persnally]` table (and its `.env`
 * subtable), keep every other byte verbatim, append the fresh block. Table
 * headers are line-anchored in TOML, which is what makes this well-defined.
 */
export function upsertCodexToml(existing: string, block: string): string {
  const kept: string[] = [];
  let skipping = false;
  for (const line of existing.split("\n")) {
    const header = /^\s*\[([^[\]]+)\]\s*$/.exec(line);
    if (header) {
      const name = header[1]!.trim();
      skipping = name === "mcp_servers.persnally" || name.startsWith("mcp_servers.persnally.");
    }
    if (!skipping) kept.push(line);
  }
  const body = kept.join("\n").trimEnd();
  return (body ? `${body}\n\n` : "") + block + "\n";
}

/** VS Code stores user-level MCP config beside its other user settings. */
function vscodeUserDir(home: string): string {
  if (process.platform === "darwin") return join(home, "Library", "Application Support", "Code", "User");
  if (process.platform === "win32") return join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "Code", "User");
  return join(home, ".config", "Code", "User");
}

function configPathFor(client: Client): { file: string; installed: boolean; shape: Shape } {
  const home = homedir();
  switch (client) {
    case "claude-code": {
      const file = join(home, ".claude.json");
      return { file, installed: existsSync(file) || existsSync(join(home, ".claude")), shape: "mcpServers" };
    }
    case "claude-desktop": {
      const dir = join(home, "Library", "Application Support", "Claude");
      return { file: join(dir, "claude_desktop_config.json"), installed: existsSync(dir), shape: "mcpServers" };
    }
    case "cursor": {
      const dir = join(home, ".cursor");
      return { file: join(dir, "mcp.json"), installed: existsSync(dir), shape: "mcpServers" };
    }
    case "codex": {
      const dir = join(home, ".codex");
      return { file: join(dir, "config.toml"), installed: existsSync(dir), shape: "toml" };
    }
    case "gemini-cli": {
      const dir = join(home, ".gemini");
      return { file: join(dir, "settings.json"), installed: existsSync(dir), shape: "mcpServers" };
    }
    case "windsurf": {
      const dir = join(home, ".codeium", "windsurf");
      // Windsurf does not create mcp_config.json itself, so presence of the
      // directory — not the file — is what says the client is installed.
      return { file: join(dir, "mcp_config.json"), installed: existsSync(dir), shape: "mcpServers" };
    }
    case "zed": {
      const dir = join(home, ".config", "zed");
      return { file: join(dir, "settings.json"), installed: existsSync(dir), shape: "context_servers" };
    }
    case "vscode": {
      const dir = vscodeUserDir(home);
      return { file: join(dir, "mcp.json"), installed: existsSync(dir), shape: "servers" };
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

/** The server entry in whichever shape this client expects. */
function serverEntry(shape: Exclude<Shape, "toml">, serverPath: string, client: Client, token: string): unknown {
  const env = { PERSNALLY_CLIENT: client, PERSNALLY_CLIENT_TOKEN: token };
  switch (shape) {
    case "context_servers":
      return { source: "custom", command: { path: "node", args: [serverPath], env } };
    case "servers":
      return { type: "stdio", command: "node", args: [serverPath], env };
    case "mcpServers":
      return { command: "node", args: [serverPath], env };
  }
}

/** Returns the config file written, or null when the client isn't installed. */
export function connectClient(client: Client): string | null {
  const { file, installed, shape } = configPathFor(client);
  if (!installed) return null;

  // Each connect mints (or rotates) this client's identity token — the daemon
  // then refuses this client name without it, so scopes/revocations can't be
  // bypassed by a client claiming someone else's name.
  const token = issueToken(client);
  const serverPath = mcpServerPath();

  if (shape === "toml") {
    const existing = existsSync(file) ? readFileSync(file, "utf-8") : "";
    writeTextAtomic(file, upsertCodexToml(existing, codexBlock(serverPath, client, token)));
    return file;
  }

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
  const servers = (cfg[shape] ??= {}) as Record<string, unknown>;
  servers.persnally = serverEntry(shape, serverPath, client, token);
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
