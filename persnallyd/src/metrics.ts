/**
 * The opt-in funnel ping. Off unless the person turns it on, and when on it
 * sends one ping per stage (retried until accepted): a random install id, the stage name and
 * the version — `pingPayload` is the whole of it. No topic, claim, path, count
 * or hostname can reach it because none is ever handed to this module.
 *
 * The id is random rather than derived, so it identifies nothing but itself,
 * and turning metrics off discards it: turning them on again is a new install
 * as far as the server can tell.
 */

import { randomUUID } from "node:crypto";
import { loadConfig, saveConfig } from "./config.js";
import type { Activity } from "./store.js";

export const PING_URL = "https://persnally.com/api/ping";
export const STAGES = ["installed", "activated", "returned", "week2"] as const;
export type Stage = (typeof STAGES)[number];

export interface MetricsState { id: string; sent: Stage[] }
export interface Ping { id: string; stage: Stage; v: string }
export type PostPing = (ping: Ping) => Promise<boolean>;

/** null = off. `asked` separates "never asked" from "said no", so setup asks once. */
export function metricsState(): { state: MetricsState | null; asked: boolean } {
  const m = loadConfig().metrics;
  if (m && typeof m === "object" && typeof (m as MetricsState).id === "string") {
    const sent = Array.isArray((m as MetricsState).sent) ? (m as MetricsState).sent : [];
    return { state: { id: (m as MetricsState).id, sent: sent.filter((s) => STAGES.includes(s)) }, asked: true };
  }
  return { state: null, asked: m === false };
}

export function enableMetrics(): MetricsState {
  const existing = metricsState().state;
  if (existing) return existing;
  const state: MetricsState = { id: randomUUID(), sent: [] };
  saveConfig({ metrics: state });
  return state;
}

export function disableMetrics(): void {
  saveConfig({ metrics: false });
}

/** False when off or when all four stages have landed — lets the daemon skip the activity query. */
export function pingsPending(): boolean {
  const { state } = metricsState();
  return !!state && state.sent.length < STAGES.length;
}

/** Every stage this install has reached, in funnel order. */
export function reachedStages(a: Activity): Stage[] {
  const stages: Stage[] = ["installed"];
  if (!a.firstReadAt || !a.lastReadAt) return stages;
  stages.push("activated");
  // Returned = an AI read on a later calendar day than the first one.
  if (a.lastReadAt.slice(0, 10) > a.firstReadAt.slice(0, 10)) stages.push("returned");
  if (a.retainedWeek2 === true) stages.push("week2");
  return stages;
}

export function pingPayload(id: string, stage: Stage, version: string): Ping {
  return { id, stage, v: version };
}

/** Exactly what is sent, shown before asking and on `persnally metrics`. */
export function disclosure(version: string, id = "<a random id made when you say yes>"): string {
  return [
    "Anonymous funnel ping — off unless you turn it on. If on, Persnally sends this and nothing else,",
    `once per stage (${STAGES.join(" → ")}), to ${PING_URL}:`,
    `    ${JSON.stringify(pingPayload(id, "activated", version))}`,
    "No topics, claims, file paths, counts or names — they are never handed to the code that sends.",
    "Like any HTTPS request it reaches our host from your IP; the row we keep has no IP.",
  ].join("\n");
}

const httpPost: PostPing = async (ping) => {
  const res = await fetch(PING_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(ping),
    signal: AbortSignal.timeout(5000),
  });
  return res.ok;
};

/**
 * Send each reached stage that has not been sent yet; returns the ones that
 * landed. A stage is recorded only after the server accepts it, so a failure
 * is retried on the next tick. Failures are deliberately silent: being offline
 * is normal for a local-first tool, and `persnally metrics` shows what is
 * still pending.
 */
export async function sendPendingPings(a: Activity, version: string, post: PostPing = httpPost): Promise<Stage[]> {
  const { state } = metricsState();
  if (!state) return [];
  const landed: Stage[] = [];
  for (const stage of reachedStages(a)) {
    if (state.sent.includes(stage)) continue;
    const ok = await post(pingPayload(state.id, stage, version)).catch(() => false);
    if (!ok) break;
    landed.push(stage);
    // Re-read before saving: `persnally metrics off` may have run while the request was in flight.
    const current = metricsState().state;
    if (!current || current.id !== state.id) break;
    saveConfig({ metrics: { id: current.id, sent: [...current.sent, stage] } });
  }
  return landed;
}
