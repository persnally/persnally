/**
 * Human-readable provenance for the "why?" panels — where a fact actually
 * came from. Port of the classic dashboard's provLabel and friends; the
 * wording is part of the trust surface, keep it stable.
 */

import type { EventEnvelope } from "../api/types";

const IMPORT_TOOL: Record<string, string> = {
  "import:claude": "Claude export",
  "import:chatgpt": "ChatGPT export",
  "import:claude-code": "Claude Code",
  "import:cursor": "Cursor",
  "import:codex": "Codex",
};

const CLIENT_NAMES: Record<string, string> = {
  "claude-code": "Claude Code",
  "claude-desktop": "Claude Desktop",
  cursor: "Cursor",
  "codex-cli": "Codex CLI",
  "gemini-cli": "Gemini CLI",
  windsurf: "Windsurf",
  zed: "Zed",
  vscode: "VS Code",
  cli: "CLI",
  dashboard: "dashboard",
};

export const prettyClient = (c: string): string => CLIENT_NAMES[c] ?? c;

export function clientOf(ev: EventEnvelope): string {
  const c = ev.provenance["client"];
  if (typeof c === "string" && c) return c;
  if (ev.source.startsWith("mcp:")) return ev.source.slice(4);
  if (ev.source.startsWith("hook:")) return ev.source.slice(5);
  return ev.source || "local";
}

/** A read performed for an AI client, over MCP or injected by its hook. Both
    are the client consuming context; only the mechanism differs. */
export const isClientRead = (source: string): boolean =>
  source.startsWith("mcp:") || source.startsWith("hook:");

export function provLabel(e: EventEnvelope): string {
  const p = e.provenance;
  const kind = typeof p["kind"] === "string" ? p["kind"] : "local";
  if (kind === "local" && p["surface"] === "hook") {
    return `${prettyClient(String(p["client"] ?? ""))} · session start`;
  }
  if (kind === "import") {
    const base = IMPORT_TOOL[e.source] ?? (typeof p["file"] === "string" ? p["file"] : "import");
    const convo = p["conversation_uuid"];
    return convo ? `${base} · conversation ${String(convo).slice(0, 8)}` : base;
  }
  if (kind === "mcp") {
    const session = p["session"] ? ` · session ${String(p["session"]).slice(0, 8)}` : "";
    return `${prettyClient(String(p["client"] ?? ""))}${session} · live`;
  }
  if (kind === "git") return `git: ${String(p["repo"] ?? "")}${p["ref"] ? ` @ ${String(p["ref"])}` : ""}`;
  if (kind === "derived") {
    const n = Array.isArray(p["from"]) ? p["from"].length : 0;
    return `inferred from ${n} signal${n === 1 ? "" : "s"}`;
  }
  if (kind === "local") return `you · ${String(p["surface"] ?? "local")}`;
  return kind;
}

/** One-line summary of an event payload for evidence rows. */
export function eventSummary(e: EventEnvelope): string {
  const p = e.payload;
  if (e.type === "signal.topic") return `${String(p["topic"] ?? "")} (${String(p["intent"] ?? "")})`;
  const claim = p["claim"] ?? p["topic"];
  if (typeof claim === "string") return claim;
  return JSON.stringify(p).slice(0, 90);
}
