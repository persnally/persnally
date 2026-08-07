/**
 * search_context — targeted lookup over what Persnally knows. Deterministic
 * and offline, backed by SQLite's FTS5 index (see EventStore.reindexSearch).
 *
 * This used to be literal substring matching, which failed the way an AI
 * actually queries: "tests" missed "testing", "postgres" missed "PostgreSQL",
 * every token counted the same whether it was a rare project name or the word
 * "code", and "rust" matched "trusted". FTS5 fixes all four at once — porter
 * stemming, prefix queries, bm25 (which is IDF), and real tokenization instead
 * of `includes()`.
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

/**
 * Names that stemming and prefixes can't bridge because they share no letters.
 * Deliberately small and one-directional-per-entry: a wrong alias silently
 * returns someone else's data, so this only holds pairs that are genuinely the
 * same thing.
 */
const ALIASES: Record<string, string[]> = {
  kubernetes: ["k8s"], k8s: ["kubernetes"],
  postgres: ["postgresql"], postgresql: ["postgres"],
  javascript: ["js"], typescript: ["ts"],
  python: ["py"], golang: ["go"],
  ml: ["machine", "learning"], ai: ["artificial", "intelligence"],
  db: ["database"], database: ["db"],
  auth: ["authentication", "authorization"],
  ci: ["continuous", "integration"],
  k8: ["kubernetes"],
};

/** Query tokenizer, shared with the ask corpus so both rank material the same way. */
export function queryTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s.+#-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/**
 * Builds an FTS5 MATCH expression: each token quoted (so `c++` and `next.js`
 * can't be read as operators) and prefixed (so "postgres" reaches
 * "PostgreSQL"), OR'd together with any known aliases.
 */
export function matchExpression(tokens: string[]): string {
  const terms = new Set<string>();
  for (const t of tokens) {
    // FTS5 phrases are double-quoted; an embedded quote would break the query.
    const safe = t.replace(/"/g, "");
    if (!safe) continue;
    terms.add(`"${safe}"*`);
    for (const alias of ALIASES[safe] ?? []) terms.add(`"${alias}"*`);
  }
  return [...terms].join(" OR ");
}

/** Kept for the ask corpus, which ranks in-memory material it already holds. */
export function overlapScore(tokens: string[], text: string): number {
  const hay = ` ${text.toLowerCase()} `;
  let hits = 0;
  for (const q of tokens) if (hay.includes(` ${q}`) || hay.includes(`${q} `)) hits++;
  return hits;
}

export function searchContext(
  store: EventStore,
  query: string,
  opts: { limit?: number; allowed?: Category[] | null } = {},
): SearchHit[] {
  const tokens = queryTokens(query);
  if (!tokens.length) return [];
  const limit = opts.limit ?? 10;
  const allowed = opts.allowed ?? null;

  // Assertions are cross-category prose — scoped clients don't get them
  // (same boundary as /profile and /ask).
  const ranked = store.searchIndex(matchExpression(tokens), {
    limit: limit * 3, // over-fetch: some refs may no longer resolve
    allowed: allowed ?? null,
    includeAssertions: !allowed,
  });

  const hits: SearchHit[] = [];
  for (const r of ranked) {
    if (r.kind === "topic") {
      const t = store.topicByKey(r.ref);
      if (!t) continue;
      hits.push({
        kind: "topic",
        text: t.topic,
        detail: describeTopic(t),
        // Relevance leads; decayed weight breaks ties toward what's current.
        score: r.score * (0.5 + t.weight),
        event_ids: t.event_ids.slice(0, 3),
      });
    } else {
      const e = store.getEvents([r.ref])[0];
      if (!e) continue;
      const p = e.payload as { claim: string; kind: string; confidence: number };
      hits.push({
        kind: "assertion",
        text: p.claim,
        detail: `${p.kind} · confidence ${p.confidence}`,
        score: r.score * (0.5 + (p.confidence ?? 0.5)),
        event_ids: [e.id],
      });
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
