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
    metadata?: {
      is_user_system_message?: boolean;
      user_context_message_data?: { about_user_message?: unknown; about_model_message?: unknown };
    };
  };
}

interface ChatGPTConversation {
  conversation_id?: string;
  id?: string;
  title?: string;
  create_time?: number;
  mapping?: Record<string, ChatGPTNode>;
}

/**
 * The user's Custom Instructions — the single highest-signal-per-byte artifact
 * in a ChatGPT export, because the user wrote it *about themselves*. It rides
 * in the mapping as a system message, and was dropped entirely by the
 * `role === "user"` filter.
 *
 * The exact field names are not documented by OpenAI and this was written
 * without a real export to check against, so it reads the two shapes reported
 * in the wild and ignores anything else. Only system messages explicitly
 * flagged `is_user_system_message` are read: an unflagged system prompt is a
 * custom GPT's instructions, not the user's self-description, and scraping
 * those would poison the profile with someone else's words.
 */
function parseCustomInstructions(mapping: Record<string, ChatGPTNode>): string {
  const found: string[] = [];
  for (const node of Object.values(mapping)) {
    const m = node.message;
    if (m?.author?.role !== "system" || !m.metadata?.is_user_system_message) continue;

    const ctx = m.metadata.user_context_message_data;
    const about = typeof ctx?.about_user_message === "string" ? ctx.about_user_message.trim() : "";
    const style = typeof ctx?.about_model_message === "string" ? ctx.about_model_message.trim() : "";
    if (about) found.push(`What the user says about themselves:\n${about}`);
    if (style) found.push(`How the user asks to be responded to:\n${style}`);

    // Older exports put the text straight in content.parts instead.
    if (!about && !style) {
      const parts = (m.content?.parts ?? [])
        .filter((p): p is string => typeof p === "string" && p.trim().length > 0);
      if (parts.length) found.push(parts.join("\n").trim());
    }
  }
  // The same instructions repeat across every conversation in the export.
  return [...new Set(found)].join("\n\n");
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

  const instructions = [...new Set(raw.map((c) => parseCustomInstructions(c.mapping ?? {})).filter(Boolean))];
  return { conversations, memoryText: instructions.join("\n\n"), projects: [] };
}

export async function extractChatGPTEvents(
  parsed: ParsedExport,
  extract: LlmExtract = anthropicExtract,
  model = DEFAULT_EXTRACT_MODEL,
  onProgress?: (done: number, total: number) => void,
): Promise<ImportResult> {
  return extractEvents(parsed, { source: "import:chatgpt", importer: "chatgpt", file: "conversations.json", onProgress }, extract, model);
}
