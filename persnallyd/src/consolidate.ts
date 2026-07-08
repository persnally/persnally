/**
 * Nightly consolidation — the daemon reflects while the user sleeps.
 * Always refreshes decay; with an engine and enough new signal it emits
 * behavior assertions (provenance: derived from the events considered)
 * and re-synthesizes the profile. Last-run state lives in config, not
 * the event log — it's operational state, not user data.
 */

import { z } from "zod";
import { loadConfig, saveConfig } from "./config.js";
import { newEvent, PAYLOAD_SCHEMAS, type PersnallyEvent } from "./events.js";
import { chooseExtractor, type ChosenExtractor } from "./llm.js";
import { refreshScopedProfiles, synthesizeProfile } from "./profile.js";
import type { EventStore } from "./store.js";

const ASSERTION_MIN_SIGNALS = 5;
const PROFILE_MIN_SIGNALS = 10;
const PROVENANCE_CAP = 100;
export const CONSOLIDATION_HOUR = 3; // local time

const STYLE_BACKLOG_CAP = 80;

export interface ConsolidationResult {
  newSignals: number;
  assertions: number;
  profileRefreshed: boolean;
  stylePruned: number;
}

/** Run once per local day, at or after the consolidation hour. */
export function shouldRunNow(lastRun: string | undefined, now: Date): boolean {
  if (now.getHours() < CONSOLIDATION_HOUR) return false;
  if (!lastRun) return true;
  const last = new Date(lastRun);
  return last.toDateString() !== now.toDateString();
}

const reflection = z.object({
  assertions: z.array(PAYLOAD_SCHEMAS["signal.assertion"]).max(3),
});

export async function runConsolidation(
  store: EventStore,
  engine: ChosenExtractor | null,
  now: Date = new Date(),
): Promise<ConsolidationResult> {
  const lastRun = loadConfig().last_consolidation;
  const since = typeof lastRun === "string" ? lastRun : new Date(0).toISOString();

  // recorded_at, not ts: imports carry historical ts but are new to the store.
  const newSignals = store
    .query({ limit: 100_000, recordedSince: since })
    .filter((e) => e.type.startsWith("signal."));

  // Decay shifts daily even with no new events — always re-derive.
  store.rebuild(now.getTime());

  // Distill the voice layer: live `observed` capture has no equivalent of decay,
  // so bound the backlog to the richest signals (capture small, store distilled).
  const stylePruned = store.pruneStyle(STYLE_BACKLOG_CAP);

  let assertions: PersnallyEvent[] = [];
  if (engine && newSignals.length >= ASSERTION_MIN_SIGNALS) {
    const summary = newSignals
      .map((e) => {
        const p = e.payload as Record<string, unknown>;
        return e.type === "signal.topic"
          ? `- topic: ${p.topic} (${p.intent}, ${p.sentiment}, weight ${p.weight})`
          : `- ${e.type}: ${JSON.stringify(p).slice(0, 140)}`;
      })
      .join("\n");
    const result = await engine.extract({
      model: engine.model,
      instruction:
        "These are signals from one user's recent AI activity. Identify at most 3 behavioral patterns worth remembering — recurring focus, a shift in attention, a decision pattern. kind must be 'behavior'. Only assert what this evidence supports; fewer good assertions beat filler.",
      schema: reflection,
      content: summary,
    });
    const from = newSignals.slice(0, PROVENANCE_CAP).map((e) => e.id);
    assertions = reflection.parse(result).assertions.map((a) =>
      newEvent("signal.assertion", "system", a, { kind: "derived", from }, now.toISOString()),
    );
    if (assertions.length) {
      store.append(assertions);
      store.rebuild(now.getTime());
    }
  }

  // The profile is the centerpiece artifact — always synthesize it with the
  // profile model, not the cheaper assertions engine passed in as `engine`.
  let profileRefreshed = false;
  if (engine && newSignals.length >= PROFILE_MIN_SIGNALS) {
    const profileEngine = await chooseExtractor("profile");
    await synthesizeProfile(store, profileEngine.extract, profileEngine.model);
    await refreshScopedProfiles(store, profileEngine.extract, profileEngine.model);
    profileRefreshed = true;
  }

  saveConfig({ last_consolidation: now.toISOString() });
  return { newSignals: newSignals.length, assertions: assertions.length, profileRefreshed, stylePruned };
}
