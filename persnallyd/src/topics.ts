/**
 * Near-duplicate topic grouping.
 *
 * Extraction names the same interest differently every time it sees it ("0byte
 * product strategy and market validation" / "…validation and market positioning"
 * / "…validation and market fit"), so the interest list splits one topic into
 * three weaker ones — diluting exactly what `get_context` serves and making the
 * model look less certain than its evidence.
 *
 * Grouping happens in the derived view only: the event log stays append-only and
 * every constituent event keeps its own provenance. Turning the threshold up or
 * down re-derives cleanly and destroys nothing.
 */

/**
 * Calibrated on a real 1,886-topic store: 0.6 folds 42 variants into 15 groups
 * with no false merge, while 0.5 wrongly fused a Product Hunt launch with a
 * different product's launch. Deliberately under-merges — a wrong merge is a
 * false claim about the person, a missed one is only redundancy.
 */
export const TOPIC_MERGE_THRESHOLD = 0.6;

/** Words that carry no topical signal, so they must not create similarity. */
const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "for", "of", "to", "in", "on", "with", "without",
  "vs", "versus", "into", "from", "at", "by", "as", "is", "are", "be", "using",
  "use", "via", "about", "over", "under", "new", "my", "our", "its",
]);

/** Content tokens of a topic key (keys arrive underscore-joined, lowercased). */
export function topicTokens(key: string): Set<string> {
  const out = new Set<string>();
  for (const raw of key.split(/[_\s-]+/)) {
    const t = raw.trim();
    if (t.length > 1 && !STOPWORDS.has(t)) out.add(t);
  }
  return out;
}

/**
 * Jaccard overlap of content tokens. Symmetric, so grouping doesn't depend on
 * which variant is examined first.
 */
export function topicSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / (a.size + b.size - shared);
}

export interface TopicCandidate {
  /** Normalized key — the identity used by the view and by forget. */
  key: string;
  category: string;
  /** Decayed weight, used to pick which phrasing survives as canonical. */
  weight: number;
}

/**
 * Groups near-duplicate candidates. The heaviest variant is canonical: it is the
 * phrasing the user's own activity most supports, which beats "longest" (the
 * longest is often the most incidental).
 *
 * Only `limit` heaviest candidates are considered. The long tail is never
 * served or displayed, and pairwise comparison over every topic a large store
 * accumulates would put an O(n²) scan on the rebuild hot path.
 */
export function groupNearDuplicates(
  candidates: TopicCandidate[],
  threshold: number,
  limit = 200,
): Map<string, string> {
  const canonicalOf = new Map<string, string>();
  const ranked = [...candidates].sort((a, b) => b.weight - a.weight).slice(0, limit);
  const tokens = new Map<string, Set<string>>();
  for (const c of ranked) tokens.set(c.key, topicTokens(c.key));

  // Heaviest-first, so a group always forms around its strongest member and a
  // variant can never capture one that outweighs it.
  for (let i = 0; i < ranked.length; i++) {
    const head = ranked[i]!;
    if (canonicalOf.has(head.key)) continue; // already absorbed
    for (let j = i + 1; j < ranked.length; j++) {
      const other = ranked[j]!;
      if (canonicalOf.has(other.key)) continue;
      // Same category only: "pricing strategy" as business and as technology are
      // different interests wearing similar words.
      if (other.category !== head.category) continue;
      if (topicSimilarity(tokens.get(head.key)!, tokens.get(other.key)!) >= threshold) {
        canonicalOf.set(other.key, head.key);
      }
    }
  }
  return canonicalOf;
}
