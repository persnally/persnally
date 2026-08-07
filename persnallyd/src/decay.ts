/**
 * Interest weighting, ported from v1's interest-engine with the double-count fix:
 * v1 summed raw weights per signal AND multiplied a frequency bonus on top, defeating
 * the half-life for repeated topics. Here each signal decays individually and
 * frequency emerges from the decayed sum alone.
 */

/**
 * How fast interest in a category actually fades. A single 7-day half-life
 * treated a career and a debugging session identically: after 30 days any
 * signal was at ~5%, so importing a two-year archive collapsed it to
 * "whatever happened last week" — the opposite of what import-driven
 * onboarding promises, and it made the deepest part of the corpus worthless.
 *
 * Slow-moving parts of a person (what they do for a living, their health,
 * their money) persist for years; a news item genuinely doesn't.
 */
export const DEFAULT_HALF_LIFE_DAYS: Record<string, number> = {
  career: 120, health: 120, finance: 120,
  business: 60, creative: 60, education: 60, science: 60, lifestyle: 60,
  technology: 30,
  other: 30,
  news: 7,
};
const FALLBACK_HALF_LIFE_DAYS = 30;
const MS_PER_DAY = 86_400_000;
const MAX_WEIGHT = 10;

const DEPTH_SCORES: Record<string, number> = { mention: 0.3, moderate: 0.6, deep: 1.0 };
const SENTIMENT_VALUES: Record<string, number> = { positive: 0.5, negative: -0.5, neutral: 0 };

export interface WeightSignal {
  ts: string;
  weight: number;
  depth: string;
  sentiment: string;
  intent: string;
}

export interface TopicWeight {
  weight: number;
  sentiment_balance: number;
  dominant_intent: string;
}

export function halfLifeFor(category: string, overrides: Record<string, number> = {}): number {
  const v = overrides[category] ?? DEFAULT_HALF_LIFE_DAYS[category] ?? FALLBACK_HALF_LIFE_DAYS;
  // A zero or negative half-life would divide by zero / invert the curve.
  return Number.isFinite(v) && v > 0 ? v : FALLBACK_HALF_LIFE_DAYS;
}

export function topicWeight(
  signals: WeightSignal[],
  now: number = Date.now(),
  category = "other",
  overrides: Record<string, number> = {},
): TopicWeight {
  const lambda = Math.LN2 / halfLifeFor(category, overrides);
  let sum = 0;
  let sentiment = 0;
  const intents = new Map<string, number>();

  for (const s of signals) {
    const parsed = Date.parse(s.ts);
    if (!Number.isFinite(parsed)) continue; // an unparseable ts must not turn the sum into NaN
    const days = Math.max((now - parsed) / MS_PER_DAY, 0);
    sum += s.weight * (DEPTH_SCORES[s.depth] ?? 0.3) * Math.exp(-lambda * days);
    sentiment += SENTIMENT_VALUES[s.sentiment] ?? 0;
    intents.set(s.intent, (intents.get(s.intent) ?? 0) + 1);
  }

  const balance = signals.length ? sentiment / signals.length : 0;
  // Negative sentiment deprioritizes (floor 0.2), never boosts.
  const sentimentMultiplier = Math.max(0.2, 1 + Math.min(balance, 0) * 0.8);
  // Most-frequent intent — v1 documented this but actually took the latest.
  const dominant = [...intents.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "discussing";

  return {
    weight: Math.min(sum * sentimentMultiplier, MAX_WEIGHT),
    sentiment_balance: balance,
    dominant_intent: dominant,
  };
}
