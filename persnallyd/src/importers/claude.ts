/**
 * Claude data-export importer. Phase 0 finding: memories.json and projects
 * are the highest-signal-per-byte sources — treated as first-class.
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { anthropicExtract, DEFAULT_EXTRACT_MODEL, type LlmExtract } from "../llm.js";
import { extractEvents, readImportFile, type ImportResult, type ParsedConversation, type ParsedExport } from "./extract.js";

export function parseClaudeExport(dir: string): ParsedExport {
  const convPath = join(dir, "conversations.json");
  if (!existsSync(convPath)) throw new Error(`No conversations.json in ${dir}`);

  const raw = JSON.parse(readImportFile(convPath)) as Array<Record<string, unknown>>;
  const conversations: ParsedConversation[] = raw.map((c) => ({
    uuid: String(c.uuid ?? ""),
    name: String(c.name ?? ""),
    summary: String(c.summary ?? ""),
    created_at: String(c.created_at ?? new Date().toISOString()),
    userMessages: ((c.chat_messages as Array<Record<string, unknown>>) ?? [])
      .filter((m) => m.sender === "human")
      .map((m) => (m.text ? String(m.text) : textFromContent(m.content)))
      .filter((t) => t.trim()),
    assistantMessages: ((c.chat_messages as Array<Record<string, unknown>>) ?? [])
      .filter((m) => m.sender === "assistant")
      .map((m) => (m.text ? String(m.text) : textFromContent(m.content)))
      .filter((t) => t.trim()),
  }));

  let memoryText = "";
  const memPath = join(dir, "memories.json");
  if (existsSync(memPath)) {
    const memories = JSON.parse(readFileSync(memPath, "utf-8")) as Array<Record<string, unknown>>;
    memoryText = memories.map((m) => String(m.conversations_memory ?? "")).join("\n");
  }

  const projects: ParsedExport["projects"] = [];
  const projDir = join(dir, "projects");
  if (existsSync(projDir)) {
    for (const f of readdirSync(projDir).filter((f) => f.endsWith(".json"))) {
      const p = JSON.parse(readFileSync(join(projDir, f), "utf-8")) as Record<string, unknown>;
      if (p.is_starter_project) continue;
      projects.push({ name: String(p.name ?? ""), description: String(p.description ?? "") });
    }
  }

  return { conversations, memoryText, projects };
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c) => (c && typeof c === "object" ? String((c as Record<string, unknown>).text ?? "") : "")).join(" ");
  }
  return "";
}

export async function extractClaudeEvents(
  parsed: ParsedExport,
  extract: LlmExtract = anthropicExtract,
  model = DEFAULT_EXTRACT_MODEL,
  onProgress?: (done: number, total: number) => void,
): Promise<ImportResult> {
  return extractEvents(parsed, { source: "import:claude", importer: "claude", file: "conversations.json", onProgress }, extract, model);
}
