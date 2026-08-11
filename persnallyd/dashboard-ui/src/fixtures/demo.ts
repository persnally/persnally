/**
 * Sample data for the marketing preview (?demo=1). Reachable ONLY through the
 * demo client in api/client.ts — no view may import this module directly
 * (enforced by test/dashboard-next.test.ts). A real user never sees it.
 */

import type {
  Activity, AskResult, EngineStatus, EventEnvelope, Health, Profile, Questions, Scopes, Skill, Stats,
  TopicRow, Voice,
} from "../api/types";

export const DEMO_HEALTH: Health = { ok: true, version: "preview" };

export const DEMO_STATS: Stats = {
  total: 1284,
  byType: { "signal.topic": 903, "signal.assertion": 214, "context.read": 141, "signal.style": 26 },
  bySource: { "import:chatgpt": 640, "import:claude": 263, "mcp:claude-code": 221, "import:git": 160 },
  first: "2025-11-02T09:14:00Z",
  last: new Date().toISOString(),
};

const topic = (
  topic: string, category: string, weight: number, intent: string, signals: number, entities: string[], id: string,
): TopicRow => ({
  topic_key: topic.toLowerCase().replace(/\s+/g, "-"),
  topic,
  category,
  signals,
  weight,
  sentiment_balance: 0.4,
  dominant_intent: intent,
  entities,
  first_seen: "2026-02-11T10:00:00Z",
  last_seen: "2026-08-09T10:00:00Z",
  event_ids: [id],
});

export const DEMO_TOPICS: TopicRow[] = [
  topic("PostgreSQL query planning", "technology", 2.21, "debugging", 34, ["EXPLAIN", "pg_stat_statements"], "demo-ev-1"),
  topic("integration tests before merging", "technology", 1.94, "deciding", 28, ["playwright"], "demo-ev-2"),
  topic("pricing strategy for a solo SaaS", "business", 1.42, "researching", 19, ["PLG"], "demo-ev-4"),
  topic("incident postmortems", "career", 0.96, "reflecting", 11, [], "demo-ev-5"),
  topic("typed API boundaries", "technology", 0.81, "building", 14, ["zod"], "demo-ev-6"),
  topic("sleep and deep work", "health", 0.44, "tracking", 6, [], "demo-ev-7"),
];

export const DEMO_SKILLS: Skill[] = [
  { skill: "TypeScript", domain: "language", proficiency: 0.93, sources: 7 },
  { skill: "PostgreSQL", domain: "data", proficiency: 0.78, sources: 4 },
  { skill: "SQLite", domain: "data", proficiency: 0.66, sources: 3 },
];

export const DEMO_VOICE: Voice = {
  pack: "Writes in short declaratives, lowercase 'i', no emoji. Leads with the ask, then the reason. Prefers a bulleted list over a paragraph when there is more than one item.",
  items: [
    { dimension: "voice", pattern: "short declarative sentences", polarity: "does", confidence: 0.91, evidence: "median 9 words across 400 messages", basis: "stylometry" },
    { dimension: "voice", pattern: "emoji", polarity: "avoids", confidence: 0.88, evidence: "0 in sampled prose", basis: "stylometry" },
    { dimension: "format", pattern: "bulleted lists over prose", polarity: "prefers", confidence: 0.74, evidence: "1,700+ bulleted lines", basis: "observed" },
    { dimension: "convention", pattern: "npm, never pnpm", polarity: "insists", confidence: 0.82, evidence: "every repo uses npm", basis: "observed" },
    { dimension: "workflow", pattern: "merge, not rebase, on main", polarity: "prefers", confidence: 0.7, evidence: "shell history", basis: "observed" },
  ],
};

export const DEMO_ACTIVITY: Activity = {
  firstEventAt: "2025-11-02T09:14:00Z",
  firstReadAt: "2026-01-08T09:00:00Z",
  lastReadAt: new Date().toISOString(),
  daysSinceFirst: 283,
  daysSinceFirstRead: 216,
  totalReads: 141,
  reads7d: 22,
  reads30d: 74,
  activeDays7d: 5,
  activeDays14d: 11,
  retainedWeek2: true,
  daily: [3, 0, 5, 8, 2, 0, 1, 6, 4, 7, 2, 3, 0, 5].map((reads, i) => ({
    date: new Date(Date.now() - (13 - i) * 86400000).toISOString().slice(0, 10),
    reads,
  })),
};

export const DEMO_SCOPES: Scopes = { cursor: ["technology"], "claude-desktop": [] };

export const DEMO_EVENTS: EventEnvelope[] = [
  {
    id: "demo-ev-1",
    ts: "2026-06-14T10:02:00Z",
    recorded_at: "2026-06-14T10:02:00Z",
    source: "import:chatgpt",
    type: "signal.topic",
    payload: { topic: "PostgreSQL query planning", intent: "debugging" },
    provenance: { kind: "import", conversation_uuid: "b81f22ea-demo" },
    schema_ver: 1,
  },
  {
    id: "demo-ev-2",
    ts: "2026-07-03T16:40:00Z",
    recorded_at: "2026-07-03T16:40:00Z",
    source: "mcp:claude-code",
    type: "signal.topic",
    payload: { topic: "integration tests before merging", intent: "deciding" },
    provenance: { kind: "mcp", client: "claude-code", session: "3f9a77b1-demo" },
    schema_ver: 1,
  },
  {
    id: "demo-ev-3",
    ts: "2026-07-28T08:15:00Z",
    recorded_at: "2026-07-28T08:15:00Z",
    source: "import:claude",
    type: "signal.assertion",
    payload: { claim: "Prefers boring, proven infrastructure over novel tooling", kind: "behavior", confidence: 0.86 },
    provenance: { kind: "derived", from: ["demo-ev-1", "demo-ev-2"] },
    schema_ver: 1,
  },
  {
    id: "demo-ev-4",
    ts: "2026-05-20T12:00:00Z",
    recorded_at: "2026-05-20T12:00:00Z",
    source: "import:claude",
    type: "signal.topic",
    payload: { topic: "pricing strategy for a solo SaaS", intent: "researching" },
    provenance: { kind: "import", conversation_uuid: "cafe1234-demo" },
    schema_ver: 1,
  },
  {
    id: "demo-ev-8",
    ts: "2026-08-04T09:30:00Z",
    recorded_at: "2026-08-04T09:30:00Z",
    source: "system",
    type: "signal.assertion",
    payload: { claim: "Treats unverified output as unfinished — demands observable proof", kind: "behavior", confidence: 0.9 },
    provenance: { kind: "derived", from: ["demo-ev-2"] },
    schema_ver: 1,
  },
  ...[
    ["claude-code", "session start", "2026-08-11T09:12:00Z"],
    ["cursor", "editing a migration", "2026-08-11T08:40:00Z"],
    ["claude-code", "session start", "2026-08-10T19:02:00Z"],
  ].map(([client, purpose, ts], i): EventEnvelope => ({
    id: `demo-read-${i}`,
    ts: ts!,
    recorded_at: ts!,
    source: `mcp:${client!}`,
    type: "context.read",
    payload: { purpose: purpose!, items: 14, scope: client === "cursor" ? ["technology"] : null },
    provenance: { kind: "mcp", client: client!, session: `sess-${i}` },
    schema_ver: 1,
  })),
];

export const DEMO_PROFILE: Profile = {
  headline: "A systems thinker who ships small and verifies everything",
  sections: [
    {
      title: "How you build",
      body: "You work in small, reviewable increments and don't consider a change done until something observable proves it — a passing test, a log line, a returning exit code. You'd rather over-verify than ship on faith.",
      evidence_event_ids: ["demo-ev-2", "demo-ev-3"],
    },
    {
      title: "What you keep coming back to",
      body: "Database performance is a recurring gravity well: query planning, indexes, and the difference between fast-on-my-machine and fast-in-production.",
      evidence_event_ids: ["demo-ev-1"],
    },
    {
      title: "How you decide",
      body: "You favor boring, proven infrastructure and treat novelty as a cost. When two options tie, you pick the one that's easier to delete.",
      evidence_event_ids: ["demo-ev-3"],
    },
  ],
  generated_at: new Date().toISOString(),
  model: "sample",
};

export const DEMO_ENGINE: EngineStatus = {
  hasKey: false,
  keyMasked: "",
  hasProfile: true,
  ollama: { reachable: false, models: [], hasModel: false },
  recommended: "llama3.2",
  pull: { state: "idle", model: "", percent: 0, status: "", error: "" },
};

export const DEMO_QUESTIONS: Questions = {
  items: [
    { question_id: "demo-q-a", answer_id: "demo-a-a", ts: "2026-08-11T14:20:00Z", asker: "claude-code", question: "Would they want a test for this edge case?", answer: "Yes — unverified changes read as unfinished to them.", confidence: 0.88, deferred: false, evidence_event_ids: ["demo-ev-2", "demo-ev-8"], verdict: "approved" },
    { question_id: "demo-q-b", answer_id: "demo-a-b", ts: "2026-08-11T11:05:00Z", asker: "cursor", question: "npm or pnpm for this repo?", answer: "npm — it's what every repo of theirs uses.", confidence: 0.91, deferred: false, evidence_event_ids: ["demo-ev-2"], verdict: null },
    { question_id: "demo-q-c", answer_id: "demo-a-c", ts: "2026-08-10T19:42:00Z", asker: "claude-desktop", question: "Should I email the investor update tonight?", answer: "", confidence: 0.31, deferred: true, evidence_event_ids: [], verdict: null },
  ],
  stats: { asked: 3, answered: 2, deferred: 1, approved: 1, edited: 0, vetoed: 0, precision: 1 },
};

export const DEMO_ASK: AskResult = {
  question_id: "demo-q-1",
  answer_id: "demo-a-1",
  answer:
    "Sample answer: they would want an integration test before merging — they treat unverified changes as unfinished, and they've said so repeatedly across tools.",
  confidence: 0.84,
  deferred: false,
  evidence_event_ids: ["demo-ev-2", "demo-ev-3"],
};
