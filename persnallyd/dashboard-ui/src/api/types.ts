/**
 * The wire contract between this UI and a Persnally backend. Everything the
 * views know about data comes through these shapes — this module and client.ts
 * are the seam a future cloud dashboard swaps behind.
 */

export type Category =
  | "technology" | "business" | "finance" | "career" | "health" | "science"
  | "creative" | "education" | "lifestyle" | "news" | "other";

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

export interface EngineStatus {
  hasKey: boolean;
  keyMasked: string;
  hasProfile: boolean;
  ollama: { reachable: boolean; models: string[]; hasModel: boolean };
  recommended: string;
  pull: { state: "idle" | "pulling" | "done" | "error"; model: string; percent: number; status: string; error: string };
}

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

/** POST /ask outcomes the composer must render distinctly. */
export type AskResponse =
  | { kind: "ok"; result: AskResult }
  | { kind: "rate-limited"; message: string }
  | { kind: "http-error"; message: string };

export type BootProbe = "ok" | "unauthorized" | "unreachable";
