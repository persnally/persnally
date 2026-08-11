/**
 * Sample data for the marketing preview (?demo=1). Reachable ONLY through the
 * demo client in api/client.ts — no view may import this module directly
 * (enforced by test/dashboard-next.test.ts). A real user never sees it.
 */

import type { AskResult, EngineStatus, EventEnvelope, Health, Profile, Stats } from "../api/types";

export const DEMO_HEALTH: Health = { ok: true, version: "preview" };

export const DEMO_STATS: Stats = {
  total: 1284,
  byType: { "signal.topic": 903, "signal.assertion": 214, "context.read": 141, "signal.style": 26 },
  bySource: {},
  first: "2025-11-02T09:14:00Z",
  last: new Date().toISOString(),
};

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

export const DEMO_ASK: AskResult = {
  question_id: "demo-q-1",
  answer_id: "demo-a-1",
  answer:
    "Sample answer: they would want an integration test before merging — they treat unverified changes as unfinished, and they've said so repeatedly across tools.",
  confidence: 0.84,
  deferred: false,
  evidence_event_ids: ["demo-ev-2", "demo-ev-3"],
};
