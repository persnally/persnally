/**
 * ChatGPT data-export importer. The export's conversations.json stores each
 * conversation as a node tree ("mapping"); user text lives in author.role
 * === "user" nodes with content.parts. Multimodal parts are skipped.
 */

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { safeIso } from "../events.js";
import { anthropicExtract, DEFAULT_EXTRACT_MODEL, type LlmExtract } from "../llm.js";
import { extractEvents, readImportFile, type ImportResult, type ParsedConversation, type ParsedExport } from "./extract.js";

interface ChatGPTNode {
  message?: {
    author?: { role?: string };
    content?: { content_type?: string; parts?: unknown[] };
    create_time?: number | null;
  };
}

interface ChatGPTConversation {
  conversation_id?: string;
  id?: string;
  title?: string;
  create_time?: number;
  mapping?: Record<string, ChatGPTNode>;
}

export function parseChatGPTExport(path: string): ParsedExport {
  const file = statSync(path).isDirectory() ? join(path, "conversations.json") : path;
  if (!existsSync(file)) throw new Error(`No conversations.json at ${path}`);

  const raw = JSON.parse(readImportFile(file)) as ChatGPTConversation[];
  const conversations: ParsedConversation[] = raw.map((c) => {
    const byRole = (role: string) => Object.values(c.mapping ?? {})
      .filter((n) => n.message?.author?.role === role)
      .sort((a, b) => (a.message?.create_time ?? 0) - (b.message?.create_time ?? 0))
      .flatMap((n) => n.message?.content?.parts ?? [])
      .filter((p): p is string => typeof p === "string" && p.trim().length > 0);
    const userMessages = byRole("user");
    return {
      uuid: String(c.conversation_id ?? c.id ?? ""),
      name: String(c.title ?? ""),
      summary: "",
      created_at: safeIso(c.create_time ? c.create_time * 1000 : undefined),
      userMessages,
      assistantMessages: byRole("assistant"),
    };
  });

  return { conversations, memoryText: "", projects: [] };
}

export async function extractChatGPTEvents(
  parsed: ParsedExport,
  extract: LlmExtract = anthropicExtract,
  model = DEFAULT_EXTRACT_MODEL,
  onProgress?: (done: number, total: number) => void,
): Promise<ImportResult> {
  return extractEvents(parsed, { source: "import:chatgpt", importer: "chatgpt", file: "conversations.json", onProgress }, extract, model);
}
