/**
 * Access control for the daemon, stored in config: category scopes, per-client
 * identity tokens, and the owner's dashboard key. Scopes are default-open: a
 * client with no entry sees everything; once scoped, it sees only its allowed
 * categories. Tokens bind a client name to a secret issued at connect — a name
 * with a token can't be claimed without it, so scopes and revocations hold
 * against dishonest clients too.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
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

/**
 * Revoked (`categories: []`) is distinct from scoped: the dashboard promises a
 * revoked client "reads nothing", so it reads nothing at all — not topics, not
 * the style pack, not event counts. A *scoped* client still gets style, which
 * is how the user writes rather than what about.
 */
export function isRevoked(client: string): boolean {
  return allowedCategories(client)?.length === 0;
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

/** New key + every existing browser session dropped: sessions are signed with
    the key, so replacing it invalidates every outstanding cookie at once. */
export function rotateDashboardKey(): string {
  const key = randomBytes(24).toString("base64url");
  saveConfig({ dashboard_key: key });
  return key;
}

// ── Browser sessions ──────────────────────────────────────────

export const SESSION_COOKIE = "persnally_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_TTL_SECONDS = SESSION_TTL_MS / 1000;

/**
 * Sessions are stateless: the cookie is `v1.<expiry>.<HMAC(dashboard key, …)>`,
 * carrying its own expiry and proving itself by signature. Nothing is stored.
 *
 * The previous design kept them in an in-memory Map, which meant every daemon
 * restart silently logged the user out — launchd/systemd relaunch, an upgrade,
 * or any uncaught exception (the daemon deliberately exits so the supervisor
 * restarts it clean). Paired with a 12h hard expiry, the dashboard demanded
 * `persnally dashboard` again roughly twice a day. That is friction with no
 * security return: the cookie is HttpOnly, SameSite=Strict, loopback-only, and
 * derived from a key in a mode-0600 file — anyone who could steal the cookie
 * could read that key and mint a session anyway.
 *
 * Signing with the dashboard key preserves the property that mattered:
 * rotating the key changes the HMAC secret, so `dashboard --rotate` still
 * invalidates every outstanding session instantly, from any process.
 */
const SESSION_V = "v1";

function sign(payload: string): string {
  const key = loadConfig().dashboard_key;
  if (typeof key !== "string" || key.length < 32) return "";
  return createHmac("sha256", key).update(payload).digest("base64url");
}

/** Exchanges a verified dashboard key for a durable browser session. */
export function createSession(now: number = Date.now()): string {
  const payload = `${SESSION_V}.${now + SESSION_TTL_MS}`;
  return `${payload}.${sign(payload)}`;
}

export function sessionValid(id: string, now: number = Date.now()): boolean {
  if (!id) return false;
  const cut = id.lastIndexOf(".");
  if (cut <= 0) return false;
  const payload = id.slice(0, cut);
  const given = id.slice(cut + 1);
  const [version, expiry] = payload.split(".");
  if (version !== SESSION_V) return false;

  const expiresAt = Number(expiry);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return false;

  // No key (or a rotated one) yields a different signature — never a match.
  const expected = sign(payload);
  if (!expected || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * True once a session is past halfway, so callers can re-issue it. Keeps an
 * active user signed in indefinitely without extending a stolen cookie's life
 * beyond one full TTL from its last legitimate use.
 */
export function sessionNeedsRefresh(id: string, now: number = Date.now()): boolean {
  const expiry = Number(id.split(".")[1]);
  if (!Number.isFinite(expiry)) return false;
  return expiry - now < SESSION_TTL_MS / 2;
}
