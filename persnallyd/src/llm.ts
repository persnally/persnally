/**
 * Structured extraction shared by importers and profile synthesis.
 * Uses output_config structured outputs (broadly supported; no forced tool_choice).
 */

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

export const DEFAULT_EXTRACT_MODEL = process.env.PERSNALLY_MODEL ?? "claude-haiku-4-5";
export const DEFAULT_PROFILE_MODEL = process.env.PERSNALLY_PROFILE_MODEL ?? "claude-opus-4-8";

export type LlmExtract = (opts: {
  model: string;
  instruction: string;
  schema: z.ZodType;
  content: string;
  maxTokens?: number;
}) => Promise<unknown>;

/** Default extractor backed by the Anthropic API; injectable for tests. */
export const anthropicExtract: LlmExtract = async ({ model, instruction, schema, content, maxTokens }) => {
  const client = new Anthropic();
  const response = await client.messages.parse({
    model,
    max_tokens: maxTokens ?? 4000,
    system: instruction,
    output_config: { format: zodOutputFormat(schema) },
    messages: [{ role: "user", content }],
  });
  if (response.stop_reason === "refusal") {
    throw new Error("Extraction request was refused by the model's safety classifiers");
  }
  if (response.parsed_output == null) {
    throw new Error("Extraction returned no parseable output");
  }
  return response.parsed_output;
};

// ── Local extraction via Ollama: zero key, zero cloud ───────

const OLLAMA_URL = process.env.PERSNALLY_OLLAMA_URL ?? "http://127.0.0.1:11434";
const LOCAL_MODEL_PREFERENCE = ["qwen2.5:14b", "qwen2.5:7b", "llama3.1:8b", "llama3.2", "qwen2.5:1.5b"];

// Smallest model that still yields a usable profile — the one-click local default.
// (~2GB; bigger models in LOCAL_MODEL_PREFERENCE win automatically once present.)
export const RECOMMENDED_LOCAL_MODEL = "llama3.2";

/** Installed Ollama models, or null if Ollama isn't reachable (not installed / not running). */
export async function ollamaTags(): Promise<string[] | null> {
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return null;
    return ((await r.json()) as { models?: { name: string }[] }).models?.map((m) => m.name) ?? [];
  } catch {
    return null;
  }
}

/** Streams an `ollama pull`, reporting download progress (0–100). Throws on failure. */
export async function pullOllamaModel(
  model: string,
  onProgress: (p: { status: string; percent: number }) => void,
): Promise<void> {
  const r = await fetch(`${OLLAMA_URL}/api/pull`, {
    method: "POST",
    body: JSON.stringify({ name: model, stream: true }),
  });
  if (!r.ok || !r.body) throw new Error(`ollama pull: ${r.status} ${(await r.text().catch(() => "")).slice(0, 200)}`);
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? ""; // keep the partial last line for the next chunk
    for (const line of lines) {
      if (!line.trim()) continue;
      let obj: { status?: string; total?: number; completed?: number; error?: string };
      try { obj = JSON.parse(line); } catch { continue; }
      if (obj.error) throw new Error(`ollama pull: ${obj.error}`);
      const percent = obj.total ? Math.round(((obj.completed ?? 0) / obj.total) * 100) : 0;
      onProgress({ status: obj.status ?? "", percent });
    }
  }
}

export const ollamaExtract: LlmExtract = async ({ model, instruction, schema, content }) => {
  const r = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    body: JSON.stringify({
      model,
      stream: false,
      format: z.toJSONSchema(schema),
      messages: [
        { role: "system", content: instruction },
        { role: "user", content },
      ],
    }),
  });
  if (!r.ok) throw new Error(`ollama: ${r.status} ${await r.text()}`);
  const body = (await r.json()) as { message?: { content?: string } };
  return schema.parse(JSON.parse(body.message?.content ?? "{}"));
};

/** Preference order, not Ollama's listing order — the two rarely agree. */
export function pickLocalModel(tags: string[] | null): string | null {
  if (process.env.PERSNALLY_LOCAL_MODEL) return process.env.PERSNALLY_LOCAL_MODEL;
  if (!tags) return null;
  return LOCAL_MODEL_PREFERENCE.find((p) => tags.some((t) => t === p || t === `${p}:latest`)) ?? tags[0] ?? null;
}

/**
 * The model each job would actually run on. The dashboard names these, and a
 * surface that names a model it only guessed at (Ollama's first tag, or a
 * hardcoded default that ignores PERSNALLY_MODEL) is stating a fact it cannot
 * see — so resolution lives here and is reported, never re-derived.
 */
export function resolvedModels(hasKey: boolean, tags: string[] | null): { extract: string | null; profile: string | null } {
  if (hasKey) return { extract: DEFAULT_EXTRACT_MODEL, profile: DEFAULT_PROFILE_MODEL };
  const local = pickLocalModel(tags);
  return { extract: local, profile: local };
}

async function localModel(): Promise<string | null> {
  if (process.env.PERSNALLY_LOCAL_MODEL) return process.env.PERSNALLY_LOCAL_MODEL;
  return pickLocalModel(await ollamaTags());
}

export interface ChosenExtractor {
  extract: LlmExtract;
  model: string;
  label: string;
}

function anthropicChoice(purpose: "extract" | "profile"): ChosenExtractor {
  const model = purpose === "profile" ? DEFAULT_PROFILE_MODEL : DEFAULT_EXTRACT_MODEL;
  return { extract: anthropicExtract, model, label: `${model} (Anthropic API)` };
}

/**
 * Anthropic key wins (quality); otherwise local Ollama (privacy, zero setup);
 * otherwise guide the user.
 *
 * `force` overrides that order and never falls back. Preference-order fallback
 * is right when the user expressed no preference and wrong the moment they did:
 * with a key present, an unforced call would answer `--engine ollama` with the
 * Anthropic extractor and ship conversation text off the machine — the opposite
 * of what was asked, in the one product where that matters most.
 */
export async function chooseExtractor(
  purpose: "extract" | "profile" = "extract",
  force?: "anthropic" | "ollama",
): Promise<ChosenExtractor> {
  if (force === "anthropic") {
    if (process.env.ANTHROPIC_API_KEY) return anthropicChoice(purpose);
    throw new Error("--engine anthropic, but no API key is set. Run: persnally config set-key <sk-ant-…>");
  }
  if (force === "ollama") {
    const forced = await localModel();
    if (forced) {
      return { extract: ollamaExtract, model: forced, label: `${forced} (local via Ollama — nothing leaves this machine)` };
    }
    throw new Error("--engine ollama, but Ollama has no model available. Run: ollama pull llama3.2");
  }

  if (process.env.ANTHROPIC_API_KEY) return anthropicChoice(purpose);
  const model = await localModel();
  if (model) {
    return { extract: ollamaExtract, model, label: `${model} (local via Ollama — nothing leaves this machine)` };
  }
  throw new Error(
    "No extraction engine available. Either:\n" +
    "  - persnallyd config set-key <sk-ant-…>   (Anthropic API, best quality), or\n" +
    "  - install Ollama and `ollama pull llama3.2`   (fully local, no key), or\n" +
    "  - start key-free with: persnallyd import git <path>",
  );
}
