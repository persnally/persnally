/**
 * Access control for the daemon, stored in config: category scopes, per-client
 * identity tokens, and the owner's dashboard key. Scopes are default-open: a
 * client with no entry sees everything; once scoped, it sees only its allowed
 * categories. Tokens bind a client name to a secret issued at connect — a name
 * with a token can't be claimed without it, so scopes and revocations hold
 * against dishonest clients too.
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

// Compare secrets by digest: constant-time and length-independent.
const digest = (s: string) => createHash("sha256").update(s).digest();
const sameSecret = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));

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
  if (!token) return null;
  const given = digest(token);
  for (const [client, t] of Object.entries(loadTokens())) {
    if (timingSafeEqual(digest(t), given)) return client;
  }
  return null;
}

// ── The owner's dashboard key ─────────────────────────────────

/**
 * The credential for the owner's own surface (browser dashboard, local
 * scripts). It lives in the mode-0600 config, so holding it means having read
 * access to the user's config — which another local user, or a sandboxed
 * process, does not have. Loopback binding alone gives no such guarantee: the
 * port is reachable by every process and every user on the machine.
 */
export function dashboardKey(): string {
  const existing = loadConfig().dashboard_key;
  if (typeof existing === "string" && existing.length >= 32) return existing;
  const key = randomBytes(24).toString("base64url");
  saveConfig({ dashboard_key: key });
  return key;
}

/** Read-only check — never mints, so an unauthenticated probe can't write config. */
export function verifyDashboardKey(given: string): boolean {
  const key = loadConfig().dashboard_key;
  if (!given || typeof key !== "string" || key.length < 32) return false;
  return sameSecret(given, key);
}

/** New key + every existing browser session dropped. */
export function rotateDashboardKey(): string {
  const key = randomBytes(24).toString("base64url");
  saveConfig({ dashboard_key: key });
  sessions.clear();
  return key;
}

// ── Browser sessions ──────────────────────────────────────────

export const SESSION_COOKIE = "persnally_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const SESSION_TTL_SECONDS = SESSION_TTL_MS / 1000;
const MAX_SESSIONS = 32;

// sha256(id) → { expiry, key }. In-memory by design: sessions die with the
// daemon, and the raw id is never held, so a heap dump yields no live session.
// `key` fingerprints the dashboard key that minted the session, so a rotation
// from *any* process (the CLI is not the daemon) invalidates it — the check
// reads the current key from config rather than trusting local state.
type Session = { expiry: number; key: string };
const sessions = new Map<string, Session>();

function keyFingerprint(): string {
  const key = loadConfig().dashboard_key;
  return typeof key === "string" ? digest(key).toString("hex") : "";
}

/** Exchanges a verified dashboard key for a short-lived browser session. */
export function createSession(now: number = Date.now()): string {
  for (const [id, s] of sessions) if (s.expiry <= now) sessions.delete(id);
  // Bound the map: evict the soonest-to-expire rather than grow without limit.
  while (sessions.size >= MAX_SESSIONS) {
    let oldest: string | undefined;
    let oldestExpiry = Infinity;
    for (const [id, s] of sessions) if (s.expiry < oldestExpiry) { oldest = id; oldestExpiry = s.expiry; }
    if (oldest === undefined) break;
    sessions.delete(oldest);
  }
  const id = randomBytes(32).toString("base64url");
  sessions.set(digest(id).toString("hex"), { expiry: now + SESSION_TTL_MS, key: keyFingerprint() });
  return id;
}

export function sessionValid(id: string, now: number = Date.now()): boolean {
  if (!id) return false;
  const hashed = digest(id).toString("hex");
  const session = sessions.get(hashed);
  if (session === undefined) return false;
  if (session.expiry <= now || session.key !== keyFingerprint()) {
    sessions.delete(hashed);
    return false;
  }
  return true;
}

/** Test seam: drop every live session without rotating the key. */
export function clearSessions(): void {
  sessions.clear();
}
