/**
 * The wire contract between this UI and a Persnally backend. Everything the
 * views know about data comes through these shapes — this module and client.ts
 * are the seam a future cloud dashboard swaps behind.
 */

export type Category =
  | "technology" | "business" | "finance" | "career" | "health" | "science"
  | "creative" | "education" | "lifestyle" | "news" | "other";

export const CATEGORIES: Category[] = [
  "technology", "business", "finance", "career", "health", "science",
  "creative", "education", "lifestyle", "news", "other",
];

export interface Health {
  ok: boolean;
  version: string;
}

export interface Stats {
  total: number;
  byType: Record<string, number>;
  bySource: Record<string, number>;
  first: string | null;
  last: string | null;
}

export interface ProfileSection {
  title: string;
  body: string;
  evidence_event_ids: string[];
}

export interface Profile {
  headline: string;
  sections: ProfileSection[];
  generated_at: string;
  model: string;
}

export interface TopicRow {
  topic_key: string;
  topic: string;
  category: string;
  signals: number;
  weight: number;
  sentiment_balance: number;
  dominant_intent: string;
  entities: string[];
  first_seen: string;
  last_seen: string;
  event_ids: string[];
}

export interface Skill {
  skill: string;
  domain: string;
  proficiency: number;
  sources: number;
}

export type StyleDimension = "voice" | "convention" | "emphasis" | "format" | "workflow";

export interface StyleSignal {
  dimension: StyleDimension;
  pattern: string;
  polarity: "does" | "avoids" | "prefers" | "insists";
  confidence: number;
  evidence: string;
  basis: "observed" | "stylometry" | "correction";
}

export interface Voice {
  pack: string;
  items: StyleSignal[];
}

export interface Activity {
  firstEventAt: string | null;
  firstReadAt: string | null;
  lastReadAt: string | null;
  daysSinceFirst: number;
  daysSinceFirstRead: number;
  totalReads: number;
  reads7d: number;
  reads30d: number;
  activeDays7d: number;
  activeDays14d: number;
  retainedWeek2: boolean | null;
  daily: { date: string; reads: number }[];
}

export interface EventEnvelope {
  id: string;
  ts: string;
  recorded_at: string;
  source: string;
  type: string;
  payload: Record<string, unknown>;
  provenance: Record<string, unknown>;
  schema_ver: number;
}

export interface SearchHit {
  kind: "topic" | "assertion";
  text: string;
  detail: string;
  score: number;
  event_ids: string[];
}

export interface EnginePull {
  state: "idle" | "pulling" | "done" | "error";
  model: string;
  percent: number;
  status: string;
  error: string;
}

export interface EngineStatus {
  hasKey: boolean;
  keyMasked: string;
  hasProfile: boolean;
  ollama: { reachable: boolean; models: string[]; hasModel: boolean };
  recommended: string;
  pull: EnginePull;
}

/** Absent key = full access · [] = revoked · non-empty = limited to those. */
export type Scopes = Record<string, Category[]>;

export interface AskResult {
  question_id: string;
  answer_id: string;
  answer: string;
  confidence: number;
  deferred: boolean;
  reason?: "low-confidence" | "not-enough-context" | "no-engine";
  evidence_event_ids: string[];
}

export interface AskRow {
  question_id: string;
  answer_id: string;
  ts: string;
  asker: string;
  question: string;
  answer: string;
  confidence: number;
  deferred: boolean;
  /** Empty for answers recorded before evidence was persisted. */
  evidence_event_ids: string[];
  verdict: "approved" | "edited" | "vetoed" | null;
}

export interface AskStats {
  asked: number;
  answered: number;
  deferred: number;
  approved: number;
  edited: number;
  vetoed: number;
  precision: number | null;
}

export interface Questions {
  items: AskRow[];
  stats: AskStats;
}

export interface ImportResult {
  events: number;
  imported: string[];
  skipped: string[];
}

export interface ConsolidationResult {
  newSignals: number;
  assertions: number;
  profileRefreshed: boolean;
  stylePruned: number;
}

/** POST /ask outcomes the composer must render distinctly. */
export type AskResponse =
  | { kind: "ok"; result: AskResult }
  | { kind: "rate-limited"; message: string }
  | { kind: "http-error"; message: string };

/** Every mutation answers with this, so views can report honestly either way. */
export type Mutation<T = unknown> = { ok: true; data: T } | { ok: false; error: string };

export type BootProbe = "ok" | "unauthorized" | "unreachable";
