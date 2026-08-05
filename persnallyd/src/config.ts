/**
 * Daemon config at ~/.persnally/config.json — most importantly the Anthropic
 * key, so the launchd-run daemon (no shell env) can synthesize. Unknown fields
 * are preserved (the file predates v2). Saved with owner-only permissions.
 */

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DATA_DIR } from "./paths.js";

// Resolved at call time so PERSNALLY_DIR overrides work in-process (tests), not just for subprocesses.
function configFile(): string {
  return join(process.env.PERSNALLY_DIR ?? DATA_DIR, "config.json");
}

export function loadConfig(): Record<string, unknown> {
  const file = configFile();
  let raw: string;
  try {
    raw = readFileSync(file, "utf-8");
  } catch {
    return {}; // not created yet — the normal first-run path
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not a JSON object");
    return parsed as Record<string, unknown>;
  } catch (e) {
    // An unreadable config holds the API key, client tokens and scopes. Treating
    // it as empty silently drops all three and the next save overwrites it, so
    // keep a copy and say so loudly instead.
    const backup = `${file}.corrupt`;
    try {
      if (!existsSync(backup)) copyFileSync(file, backup);
      console.error(`config at ${file} is unreadable (${e instanceof Error ? e.message : e}); kept a copy at ${backup}`);
    } catch {
      console.error(`config at ${file} is unreadable and could not be backed up: ${e instanceof Error ? e.message : e}`);
    }
    return {};
  }
}

export function saveConfig(updates: Record<string, unknown>): void {
  const file = configFile();
  mkdirSync(dirname(file), { recursive: true });
  const merged = { ...loadConfig(), ...updates };
  // Atomic write: a crash mid-write must never leave a truncated config —
  // that would silently drop the API key and all scopes (loadConfig swallows
  // parse errors). Write to a temp file, then rename (atomic on one fs).
  // mode 0600 on create + chmod keeps the key owner-only through the swap.
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(merged, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
  chmodSync(file, 0o600);
}

/** Env wins over config; sets process.env so the Anthropic SDK picks it up. */
export function applyApiKey(): boolean {
  if (process.env.ANTHROPIC_API_KEY) return true;
  const key = loadConfig().anthropic_api_key;
  if (typeof key === "string" && key.startsWith("sk-ant-")) {
    process.env.ANTHROPIC_API_KEY = key;
    return true;
  }
  return false;
}

export function configPath(): string {
  const file = configFile();
  return existsSync(file) ? file : `${file} (not created yet)`;
}
