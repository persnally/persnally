/**
 * Thin HTTP client for persnallyd — the daemon is the single source of truth;
 * this MCP server is just a protocol adapter in front of it.
 */

const BASE = process.env.PERSNALLYD_URL ?? "http://127.0.0.1:4983";

export const DAEMON_HINT =
  "persnallyd is not running. Start it with `persnallyd serve` (or install: npm i -g persnallyd), then retry.";

export class DaemonUnreachable extends Error {
  constructor() { super(DAEMON_HINT); }
}

async function request(path: string, init?: RequestInit): Promise<Response> {
  // Identity token from connect — proves to the daemon which client this is.
  const token = process.env.PERSNALLY_CLIENT_TOKEN;
  const headers = {
    ...(init?.headers as Record<string, string> | undefined),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  try {
    return await fetch(BASE + path, { ...init, headers });
  } catch {
    throw new DaemonUnreachable();
  }
}

/** 401 bodies carry an actionable message (e.g. "re-run persnallyd connect") — surface it, not raw JSON. */
async function fail(path: string, r: Response): Promise<never> {
  const text = await r.text();
  if (r.status === 401) {
    let msg = "";
    try { msg = (JSON.parse(text) as { error?: string }).error ?? ""; } catch { /* not JSON */ }
    if (msg) throw new Error(msg);
  }
  throw new Error(`daemon ${path}: ${r.status} ${text}`);
}

export async function daemonGet<T>(path: string): Promise<T | null> {
  const r = await request(path);
  // 404 = not present yet; 403 = scoped out for this client. Both mean "no data", not an error.
  if (r.status === 404 || r.status === 403) return null;
  if (!r.ok) await fail(path, r);
  return r.json() as Promise<T>;
}

export async function daemonPost<T>(path: string, body: unknown): Promise<T> {
  const r = await request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) await fail(path, r);
  return r.json() as Promise<T>;
}

export async function daemonDelete<T>(path: string): Promise<T> {
  const r = await request(path, { method: "DELETE" });
  if (!r.ok) await fail(path, r);
  return r.json() as Promise<T>;
}
