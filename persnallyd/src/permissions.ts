/**
 * Per-client access control, stored in config: category scopes and identity
 * tokens. Scopes are default-open: a client with no entry sees everything;
 * once scoped, it sees only its allowed categories. Tokens bind a client name
 * to a secret issued at connect — a name with a token can't be claimed without
 * it, so scopes and revocations hold against dishonest clients too.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { loadConfig, saveConfig } from "./config.js";

export const CATEGORIES = [
  "technology", "business", "finance", "career", "health",
  "science", "creative", "education", "lifestyle", "news", "other",
] as const;
export type Category = (typeof CATEGORIES)[number];

export type Scopes = Record<string, Category[]>;

export function loadScopes(): Scopes {
  const s = loadConfig().client_scopes;
  return s && typeof s === "object" ? (s as Scopes) : {};
}

export function setScope(client: string, categories: Category[]): void {
  saveConfig({ client_scopes: { ...loadScopes(), [client]: categories } });
}

export function clearScope(client: string): boolean {
  const scopes = loadScopes();
  if (!(client in scopes)) return false;
  delete scopes[client];
  saveConfig({ client_scopes: scopes });
  return true;
}

/** null = unrestricted (sees all). An array = the only categories this client may read. */
export function allowedCategories(client: string): Category[] | null {
  return loadScopes()[client] ?? null;
}

export function isAllowed(client: string, category: string): boolean {
  const allowed = allowedCategories(client);
  return allowed === null || allowed.includes(category as Category);
}

// ── Identity tokens ──────────────────────────────────────────

function loadTokens(): Record<string, string> {
  const t = loadConfig().client_tokens;
  return t && typeof t === "object" ? (t as Record<string, string>) : {};
}

/** Mints (or rotates) a client's identity token. Called at connect; the token
    is handed to that client's MCP config and never shown anywhere else. */
export function issueToken(client: string): string {
  const token = randomBytes(24).toString("base64url");
  saveConfig({ client_tokens: { ...loadTokens(), [client]: token } });
  return token;
}

export function hasToken(client: string): boolean {
  // hasOwn, not `in`: a client named "toString" must not match Object.prototype.
  return Object.hasOwn(loadTokens(), client);
}

/** The client a token identifies, or null for an unknown token. */
export function clientForToken(token: string): string | null {
  // Compare digests: constant-time and length-independent.
  const digest = (s: string) => createHash("sha256").update(s).digest();
  const given = digest(token);
  for (const [client, t] of Object.entries(loadTokens())) {
    if (timingSafeEqual(digest(t), given)) return client;
  }
  return null;
}
