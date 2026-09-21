/**
 * PersnallyClient — the only module that talks to a backend, and the only
 * module allowed to import the demo fixtures (test-enforced). Views depend on
 * the interface alone; a cloud build swaps the base URL and auth, nothing else.
 *
 * In demo mode every read answers from fixtures and every mutation is a no-op
 * that never touches the network — a preview must not be able to change or
 * destroy anything.
 */

import type {
  Activity, AskResponse, AskResult, BootProbe, Category, ConsolidationResult, Deleted, EnginePull, EngineStatus, EventEnvelope, Health, ImportResult, ImportRun, Mutation, Profile, Questions, Scopes, SearchHit, Skill, Stats, TopicRow, Voice,
} from "./types";
import {
  DEMO_ACTIVITY, DEMO_ASK, DEMO_ENGINE, DEMO_EVENTS, DEMO_HEALTH, DEMO_PROFILE, DEMO_QUESTIONS,
  DEMO_SCOPES, DEMO_SKILLS, DEMO_STATS, DEMO_TOPICS, DEMO_VOICE,
  DEMO_IMPORTS,
} from "../fixtures/demo";

export interface PersnallyClient {
  readonly mode: "live" | "demo";
  probe(): Promise<BootProbe>;
  // reads — null means "unavailable" (absent, unauthorized, or unreachable)
  health(): Promise<Health | null>;
  stats(): Promise<Stats | null>;
  /**
   * null = the daemon says there is no portrait yet (404). undefined = we
   * couldn't tell (unreachable, error, unparseable) — callers must not render
   * "no portrait yet" for that, it's an assertion about the user's data.
   */
  profile(): Promise<Profile | null | undefined>;
  topics(limit?: number): Promise<TopicRow[]>;
  skills(limit?: number): Promise<Skill[]>;
  voice(): Promise<Voice | null>;
  activity(): Promise<Activity | null>;
  engine(): Promise<EngineStatus | null>;
  scopes(): Promise<Scopes | null>;
  questions(limit?: number): Promise<Questions | null>;
  events(opts: { ids?: string[]; type?: string; limit?: number }): Promise<EventEnvelope[]>;
  imports(): Promise<ImportRun[]>;
  search(q: string): Promise<SearchHit[]>;
  pullStatus(): Promise<EnginePull | null>;
  // mutations
  ask(question: string): Promise<AskResponse>;
  forgetTopic(topic: string): Promise<Mutation<Deleted>>;
  forgetStyle(dimension: string, pattern: string): Promise<Mutation<Deleted>>;
  setScope(client: string, categories: Category[]): Promise<Mutation>;
  clearScope(client: string): Promise<Mutation>;
  judge(answerId: string, verdict: "approved" | "edited" | "vetoed"): Promise<Mutation>;
  synthesize(): Promise<Mutation<Profile>>;
  consolidate(): Promise<Mutation<ConsolidationResult>>;
  importAll(): Promise<Mutation<ImportResult>>;
  saveKey(key: string): Promise<Mutation>;
  pullModel(model?: string): Promise<Mutation>;
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
  // A 2xx with a malformed body must degrade like any other failure — a
  // rejection here would strand callers' loading states forever.
  return (await r.json().catch(() => null)) as T | null;
}

/** Mutations surface their error text: a silent failure on a delete is a lie. */
async function send<T>(
  path: string,
  onUnauthorized: () => void,
  init: { method: string; body?: unknown } = { method: "POST" },
): Promise<Mutation<T>> {
  const r = await fetch(path, {
    method: init.method,
    headers: init.body === undefined
      ? { accept: "application/json" }
      : { accept: "application/json", "content-type": "application/json" },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  }).catch(() => null);
  if (!r) return { ok: false, error: "The daemon didn't answer — is it still running?" };
  if (r.status === 401) {
    onUnauthorized();
    return { ok: false, error: "Session expired." };
  }
  const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok) {
    return { ok: false, error: typeof body.error === "string" ? body.error : `Failed (${r.status})` };
  }
  return { ok: true, data: body as T };
}

function liveClient(onUnauthorized: () => void): PersnallyClient {
  const g = <T>(p: string) => get<T>(p, onUnauthorized);
  const s = <T>(p: string, init?: { method: string; body?: unknown }) => send<T>(p, onUnauthorized, init);
  return {
    mode: "live",
    async probe() {
      // A socket that accepts but never answers would otherwise leave the page
      // blank forever — boot renders nothing until this resolves.
      const r = await fetch("/stats", { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000) }).catch(() => null);
      if (!r) return "unreachable";
      if (r.status === 401) return "unauthorized";
      // A non-persnally host (e.g. the marketing preview) answers 404 here —
      // that is "unreachable" for our purposes, exactly like a dead daemon.
      return r.ok ? "ok" : "unreachable";
    },
    health: () => g<Health>("/health"),
    stats: () => g<Stats>("/stats"),
    async profile() {
      const r = await fetch("/profile", { headers: { accept: "application/json" } }).catch(() => null);
      if (!r) return undefined;
      if (r.status === 401) { onUnauthorized(); return undefined; }
      if (r.status === 404) return null; // the daemon's honest "none yet"
      if (!r.ok) return undefined;
      return (await r.json().catch(() => null)) as Profile | null;
    },
    topics: async (limit = 40) => (await g<TopicRow[]>(`/topics?limit=${limit}`)) ?? [],
    skills: async (limit = 25) => (await g<Skill[]>(`/skills?limit=${limit}`)) ?? [],
    voice: () => g<Voice>("/voice"),
    activity: () => g<Activity>("/activity"),
    engine: () => g<EngineStatus>("/engine"),
    scopes: () => g<Scopes>("/scopes"),
    questions: (limit = 12) => g<Questions>(`/questions?limit=${limit}`),
    imports: async () => (await g<ImportRun[]>("/imports")) ?? [],
    async events(opts) {
      const q = opts.ids?.length
        ? `ids=${opts.ids.map(encodeURIComponent).join(",")}`
        : `type=${encodeURIComponent(opts.type ?? "")}&limit=${opts.limit ?? 100}`;
      return (await g<EventEnvelope[]>(`/events?${q}`)) ?? [];
    },
    search: async (q) => (await g<SearchHit[]>(`/search?q=${encodeURIComponent(q)}&limit=10`)) ?? [],
    pullStatus: () => g<EnginePull>("/engine/pull"),

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
      return { kind: "ok", result: body as unknown as AskResult };
    },

    forgetTopic: (topic) => s(`/topics/${encodeURIComponent(topic)}`, { method: "DELETE" }),
    forgetStyle: (dimension, pattern) =>
      s(`/voice/${encodeURIComponent(dimension)}/${encodeURIComponent(pattern)}`, { method: "DELETE" }),
    setScope: (client, categories) => s("/scopes", { method: "POST", body: { client, categories } }),
    clearScope: (client) => s(`/scopes/${encodeURIComponent(client)}`, { method: "DELETE" }),
    judge: (answerId, verdict) => s("/feedback", { method: "POST", body: { answer_id: answerId, verdict } }),
    synthesize: () => s<Profile>("/synthesize"),
    consolidate: () => s<ConsolidationResult>("/consolidate"),
    importAll: () => s<ImportResult>("/import", { method: "POST", body: {} }),
    saveKey: (key) => s("/engine/key", { method: "POST", body: { key } }),
    pullModel: (model) => s("/engine/pull", { method: "POST", body: model ? { model } : {} }),
  };
}

/** Every read answers from fixtures; every mutation is a no-op. Nothing leaves the page. */
function demoClient(): PersnallyClient {
  const blocked = (): Promise<Mutation<never>> =>
    Promise.resolve({ ok: false, error: "Preview mode — nothing here can be changed." });
  return {
    mode: "demo",
    probe: () => Promise.resolve("unreachable" as const),
    health: () => Promise.resolve(DEMO_HEALTH),
    stats: () => Promise.resolve(DEMO_STATS),
    profile: () => Promise.resolve(DEMO_PROFILE),
    topics: (limit = 40) => Promise.resolve(DEMO_TOPICS.slice(0, limit)),
    skills: (limit = 25) => Promise.resolve(DEMO_SKILLS.slice(0, limit)),
    voice: () => Promise.resolve(DEMO_VOICE),
    activity: () => Promise.resolve(DEMO_ACTIVITY),
    engine: () => Promise.resolve(DEMO_ENGINE),
    scopes: () => Promise.resolve(DEMO_SCOPES),
    questions: () => Promise.resolve(DEMO_QUESTIONS),
    imports: () => Promise.resolve(DEMO_IMPORTS),
    events: (opts) =>
      Promise.resolve(
        opts.ids?.length
          ? DEMO_EVENTS.filter((e) => opts.ids?.includes(e.id))
          : DEMO_EVENTS.filter((e) => !opts.type || e.type === opts.type).slice(0, opts.limit ?? 100),
      ),
    search: (q) =>
      Promise.resolve(
        DEMO_TOPICS.filter((t) => t.topic.toLowerCase().includes(q.toLowerCase())).slice(0, 10).map((t) => ({
          kind: "topic" as const,
          text: t.topic,
          detail: `${t.category} · weight ${t.weight.toFixed(2)}`,
          score: t.weight,
          event_ids: t.event_ids,
        })),
      ),
    pullStatus: () => Promise.resolve(DEMO_ENGINE.pull),
    ask: () => new Promise((resolve) => setTimeout(() => resolve({ kind: "ok", result: DEMO_ASK }), 600)),
    forgetTopic: blocked,
    forgetStyle: blocked,
    setScope: blocked,
    clearScope: blocked,
    judge: blocked,
    synthesize: blocked,
    consolidate: blocked,
    importAll: blocked,
    saveKey: blocked,
    pullModel: blocked,
  };
}

export function createClient(mode: "live" | "demo", onUnauthorized: () => void = () => {}): PersnallyClient {
  return mode === "demo" ? demoClient() : liveClient(onUnauthorized);
}
