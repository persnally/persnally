/**
 * PersnallyClient — the only module that talks to a backend, and the only
 * module allowed to import the demo fixtures (test-enforced). Views depend on
 * the interface alone; a cloud build swaps the base URL and auth, nothing else.
 */

import type { AskResponse, BootProbe, EngineStatus, EventEnvelope, Health, Profile, Stats } from "./types";
import { DEMO_ASK, DEMO_ENGINE, DEMO_EVENTS, DEMO_HEALTH, DEMO_PROFILE, DEMO_STATS } from "../fixtures/demo";

export interface PersnallyClient {
  readonly mode: "live" | "demo";
  probe(): Promise<BootProbe>;
  health(): Promise<Health | null>;
  stats(): Promise<Stats | null>;
  /** null covers both "no profile synthesized yet" (404) and transport errors. */
  profile(): Promise<Profile | null>;
  engine(): Promise<EngineStatus | null>;
  events(opts: { ids?: string[]; type?: string; limit?: number }): Promise<EventEnvelope[]>;
  ask(question: string): Promise<AskResponse>;
}

/** Session cookie rides along implicitly; a 401 anywhere means signed out. */
async function get<T>(path: string, onUnauthorized: () => void): Promise<T | null> {
  const r = await fetch(path, { headers: { accept: "application/json" } }).catch(() => null);
  if (!r) return null;
  if (r.status === 401) {
    onUnauthorized();
    return null;
  }
  if (!r.ok) return null;
  return (await r.json()) as T;
}

function liveClient(onUnauthorized: () => void): PersnallyClient {
  return {
    mode: "live",
    async probe() {
      const r = await fetch("/stats", { headers: { accept: "application/json" } }).catch(() => null);
      if (!r) return "unreachable";
      if (r.status === 401) return "unauthorized";
      // A non-persnally host (e.g. the marketing preview) answers 404 here —
      // that is "unreachable" for our purposes, exactly like a dead daemon.
      return r.ok ? "ok" : "unreachable";
    },
    health: () => get<Health>("/health", onUnauthorized),
    stats: () => get<Stats>("/stats", onUnauthorized),
    profile: () => get<Profile>("/profile", onUnauthorized),
    engine: () => get<EngineStatus>("/engine", onUnauthorized),
    async events(opts) {
      const q = opts.ids?.length
        ? `ids=${opts.ids.map(encodeURIComponent).join(",")}`
        : `type=${encodeURIComponent(opts.type ?? "")}&limit=${opts.limit ?? 100}`;
      return (await get<EventEnvelope[]>(`/events?${q}`, onUnauthorized)) ?? [];
    },
    async ask(question) {
      const r = await fetch("/ask", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ question }),
      }).catch(() => null);
      if (!r) return { kind: "http-error", message: "The daemon didn't answer — is it still running?" };
      if (r.status === 401) {
        onUnauthorized();
        return { kind: "http-error", message: "Session expired." };
      }
      const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
      if (r.status === 429) {
        return { kind: "rate-limited", message: typeof body.error === "string" ? body.error : "Ask limit reached — try again in a few minutes." };
      }
      if (!r.ok) {
        return { kind: "http-error", message: typeof body.error === "string" ? body.error : `Ask failed (${r.status})` };
      }
      return { kind: "ok", result: body as unknown as import("./types").AskResult };
    },
  };
}

/** Every read answers from fixtures; every mutation is a no-op. Nothing leaves the page. */
function demoClient(): PersnallyClient {
  return {
    mode: "demo",
    probe: () => Promise.resolve("unreachable" as const),
    health: () => Promise.resolve(DEMO_HEALTH),
    stats: () => Promise.resolve(DEMO_STATS),
    profile: () => Promise.resolve(DEMO_PROFILE),
    engine: () => Promise.resolve(DEMO_ENGINE),
    events: (opts) =>
      Promise.resolve(
        opts.ids?.length ? DEMO_EVENTS.filter((e) => opts.ids?.includes(e.id)) : DEMO_EVENTS.slice(0, opts.limit ?? 100),
      ),
    ask: () => new Promise((resolve) => setTimeout(() => resolve({ kind: "ok", result: DEMO_ASK }), 600)),
  };
}

export function createClient(mode: "live" | "demo", onUnauthorized: () => void = () => {}): PersnallyClient {
  return mode === "demo" ? demoClient() : liveClient(onUnauthorized);
}
