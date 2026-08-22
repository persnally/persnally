/**
 * Deterministic grading. No LLM judge, by design.
 *
 * Measured on the flagship long-term-memory benchmark, LLM judges pass
 * vague-but-topical *wrong* answers 62.81% of the time. A judge would therefore
 * be the largest error term in this harness — larger than anything it measures.
 * Every question here has a closed answer set, so grading is exact matching and
 * the harness has no opinion of its own.
 */

/**
 * Where each option is named, longest-first so "npm" cannot match inside "pnpm".
 * Position matters: models assert first and cite alternatives after — "npm.
 * evidence shows no indication of pnpm/yarn/bun use" names four options and
 * means one. Grading on the set of mentions marked those answers ambiguous; the
 * asserted answer is the earliest-positioned one.
 */
function locate(text, options) {
  const hay = text.toLowerCase();
  const hits = [];
  for (const opt of [...options].sort((a, b) => b.length - a.length)) {
    const re = new RegExp(`(^|[^a-z0-9])(${opt.toLowerCase().replace(/\s+/g, "\\s+")})([^a-z0-9]|$)`);
    const m = re.exec(hay);
    if (m) hits.push({ opt, at: m.index });
  }
  return hits.sort((a, b) => a.at - b.at);
}

const REFUSAL = /\b(ask (the user|them|him|her)|can'?t answer|cannot answer|don'?t (know|have)|no (evidence|record|data)|not enough|unclear|unsure)\b/i;

/**
 * One of: correct | wrong | refused | unparseable.
 *
 * `refused` is kept distinct from `wrong` on purpose: declining to answer when
 * the evidence is thin is the behaviour this product is supposed to have, and
 * folding it into `wrong` would punish exactly the honesty it sells.
 */
export function grade(text, expected, options) {
  const body = (text ?? "").trim();
  if (!body) return { verdict: "unparseable" };
  const hits = locate(body, options);
  if (hits.length === 0) {
    return { verdict: REFUSAL.test(body) ? "refused" : "unparseable" };
  }
  // A refusal that still names options ("can't say whether npm or pnpm") is a
  // refusal, not an answer.
  if (REFUSAL.test(body.split(/[.!?]/)[0] ?? "")) return { verdict: "refused", named: hits.map((h) => h.opt) };
  const asserted = hits[0].opt;
  return {
    verdict: asserted === expected ? "correct" : "wrong",
    asserted,
    alsoNamed: hits.slice(1).map((h) => h.opt),
  };
}

/** A pair scores only when both halves are correct — the point of pairing. */
export function gradePair(resA, resB) {
  return resA.verdict === "correct" && resB.verdict === "correct";
}

export function tally(results) {
  const t = { correct: 0, wrong: 0, refused: 0, unparseable: 0 };
  for (const r of results) t[r.verdict]++;
  return t;
}
