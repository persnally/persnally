/**
 * search_context — targeted lookup over what Persnally knows. Deterministic
 * and offline: token-overlap scoring over decayed topics and assertions.
 * Stores are small (hundreds–thousands of events); no index to maintain.
 */

import type { EventStore, TopicRow } from "./store.js";
import type { Category } from "./permissions.js";

export interface SearchHit {
  kind: "topic" | "assertion";
  text: string;
  detail: string;
  score: number;
  event_ids: string[];
}

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "of", "to", "in", "on", "for", "with", "about",
  "what", "how", "does", "do", "is", "are", "this", "that", "user", "they", "their",
]);

/** Query tokenizer, shared with the ask corpus so both rank material the same way. */
export function queryTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s.+#-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/** How many of the query's tokens appear in `text`. */
export function overlapScore(tokens: string[], text: string): number {
  const hay = ` ${text.toLowerCase()} `;
  let hits = 0;
  for (const q of tokens) if (hay.includes(q)) hits++;
  return hits;
}

export function searchContext(
  store: EventStore,
  query: string,
  opts: { limit?: number; allowed?: Category[] | null } = {},
): SearchHit[] {
  const q = queryTokens(query);
  if (!q.length) return [];
  const limit = opts.limit ?? 10;
  const allowed = opts.allowed ?? null;
  const hits: SearchHit[] = [];

  let topics = store.topics(1000);
  if (allowed) topics = topics.filter((t) => allowed.includes(t.category as Category));
  for (const t of topics) {
    // Name matches say more than entity matches; decayed weight breaks ties
    // toward what's current.
    const score = overlapScore(q, t.topic) * 3 + overlapScore(q, t.entities.join(" ")) * 2;
    if (score > 0) hits.push({ kind: "topic", text: t.topic, detail: describeTopic(t), score: score * (0.5 + t.weight), event_ids: t.event_ids.slice(0, 3) });
  }

  // Assertions are cross-category prose — scoped clients don't get them
  // (same boundary as /profile and /ask).
  if (!allowed) {
    for (const e of store.query({ type: "signal.assertion", limit: 1_000_000 })) {
      const p = e.payload as { claim: string; kind: string; confidence: number; evidence: string };
      const score = overlapScore(q, p.claim) * 2 + overlapScore(q, p.evidence);
      if (score > 0) hits.push({ kind: "assertion", text: p.claim, detail: `${p.kind} · confidence ${p.confidence}`, score: score * (0.5 + p.confidence), event_ids: [e.id] });
    }
  }

  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

function describeTopic(t: TopicRow): string {
  const entities = t.entities.length ? ` · ${t.entities.slice(0, 4).join(", ")}` : "";
  return `${t.category} · ${t.dominant_intent} · weight ${t.weight.toFixed(2)} · ${t.signals} signal(s)${entities}`;
}

export function renderHits(hits: SearchHit[], query: string): string {
  if (!hits.length) return `Persnally has nothing on "${query}".`;
  const lines = [`What Persnally knows about "${query}":`, ""];
  for (const h of hits) {
    lines.push(h.kind === "topic" ? `- [interest] ${h.text} (${h.detail})` : `- [observed] ${h.text} (${h.detail})`);
  }
  return lines.join("\n");
}
