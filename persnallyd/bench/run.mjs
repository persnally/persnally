/**
 * Does having Persnally make an AI measurably know this user?
 *
 * Three conditions per question, so no single number can stand alone:
 *   A  with Persnally — the real serving path (buildMaterial → model)
 *   B  no context     — the same model, same question, zero evidence. The
 *                       counterfactual: what the AI does today without this.
 *   C  withheld       — Persnally asked about a project it has no data for.
 *                       The correct answer is a refusal, so this is the only
 *                       condition that can produce a *bad* number for the
 *                       product, which is what makes A and B credible.
 *
 * Runs against a COPY of the store: askUserModel appends agent.question and
 * agent.answer events, and a benchmark that writes into the data it measures is
 * not a benchmark.
 *
 * Usage:  node bench/run.mjs [--limit=N] [--json=out.json] [--db=path] [--engine=id]
 */

import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { buildPairs, commandsByProject, familyOptions, majorityBaseline } from "./ground-truth.mjs";
import { corpusPairs } from "./corpus-questions.mjs";
import { grade, gradePair, tally } from "./grade.mjs";

const { EventStore } = await import("../build/src/store.js");
const { askUserModel } = await import("../build/src/ask.js");
const { chooseExtractor } = await import("../build/src/llm.js");
const { applyApiKey } = await import("../build/src/config.js");

const args = process.argv.slice(2);
const limit = Number(args.find((a) => a.startsWith("--limit="))?.slice(8) ?? 0) || Infinity;
const jsonOut = args.find((a) => a.startsWith("--json="))?.slice(7);
// Reproducibility matters more than answer quality here: anyone can run this
// against their own history for free on a local model, which is the whole point
// of a number you can check rather than take on trust.
const forced = args.find((a) => a.startsWith("--engine="))?.slice(9);
// Benchmark a specific store snapshot. PERSNALLY_DIR would do it, but it also
// relocates config resolution, which silently drops the API key and falls back
// to whatever local engine is installed — a different measurement entirely.
const dbOverride = args.find((a) => a.startsWith("--db="))?.slice(5);
// Build and print every question without calling a model. The question set is
// derived from the corpus, so it is worth being able to inspect it on its own —
// and it makes the harness verifiable when no engine is reachable.
const dryRun = args.includes("--dry-run");

// A zod schema, matching what the extractors actually parse against. A plain
// JSON Schema silently threw on every call and scored the control as 18
// unparseables — a harness bug that would have read as a product result.
const { z } = await import("zod");
const ANSWER_SCHEMA = z.object({
  answer: z.string(),
  confidence: z.number(),
});

/**
 * The withheld condition has no correct option — a refusal is the only right
 * answer — so it is graded against a sentinel no option can equal.
 */
const NO_CORRECT_ANSWER = "(refusal expected)";

/** Condition B: the same model, the same question, and nothing about the user. */
const BARE_INSTRUCTION = `You are answering a question about a specific software developer's habits. You have no information about them. Answer directly and concisely; if you do not know, say so and set confidence low.`;

function ask(project) {
  return `Which one does this user use in the "${basename(project)}" project?`;
}

/** One question, in the form both question sets share. */
function question(family, project, options) {
  return `${family}: Which one does this user use in the "${basename(project)}" project? Options: ${options.join(", ")}.`;
}

async function main() {
  applyApiKey();
  const { pairs, answers, excluded } = buildPairs();

  // Questions derived from the corpus rather than from our own rule table. The
  // family questions above can only ask about tools `src/workflow.ts` already
  // models, so on their own they report precision and say nothing about
  // coverage (#235). `blindSpot` marks the ones the rules cannot answer at all.
  const { modelledExecutables } = await import("../build/src/workflow.js");
  const corpus = corpusPairs(commandsByProject(), { modelled: modelledExecutables() });
  if (corpus.dropped) {
    console.log(`note: ${corpus.dropped} corpus question(s) capped away (limit per project pair)`);
  }

  if (dryRun) {
    console.log(`\nfamily questions (${pairs.length} pairs):`);
    for (const p of pairs) {
      console.log(`  ${question(p.family, p.a.project, p.options)}  -> ${p.a.answer}`);
      console.log(`  ${question(p.family, p.b.project, p.options)}  -> ${p.b.answer}`);
    }
    const blind = corpus.pairs.filter((p) => p.blindSpot).length;
    console.log(`\ncorpus questions (${corpus.pairs.length} pairs, ${blind} of them outside the rule table):`);
    for (const p of corpus.pairs) {
      console.log(`  ${p.blindSpot ? "[blind] " : "        "}${question(p.family, p.a.project, p.options)}  -> ${p.a.answer}`);
      console.log(`  ${p.blindSpot ? "[blind] " : "        "}${question(p.family, p.b.project, p.options)}  -> ${p.b.answer}`);
    }
    return;
  }
  if (!pairs.length) {
    console.error("No contrastive pairs found — not enough per-project tool evidence yet.");
    process.exit(1);
  }
  // A deterministic engine for exercising the harness itself — no network, no
  // model. It answers with the first option every time, which lands some halves
  // correct and some wrong, so every verdict branch and both report blocks get
  // executed. It says nothing whatsoever about answer quality.
  const engine = forced === "stub"
    ? { model: "stub", extract: (opts) => Promise.resolve({
        answer: (/Options: (.+)\.\s*$/m.exec(opts.content)?.[1]?.split(", ")[0]) ?? "unknown",
        confidence: 0.9, evidence_event_ids: [],
      }) }
    : await chooseExtractor("extract", forced).catch(() => null);
  if (!engine) {
    console.error("No extraction engine available (set a key or pull a local model).");
    process.exit(1);
  }

  // A copy, so benchmark asks never land in the real log.
  const dir = mkdtempSync(join(tmpdir(), "persnally-bench-"));
  const src = dbOverride ?? join(process.env.PERSNALLY_DIR ?? join(homedir(), ".persnally"), "persnally.db");
  const db = join(dir, "bench.db");
  copyFileSync(src, db);
  const store = new EventStore(db);

  const baseline = majorityBaseline(answers);
  const selected = pairs.slice(0, limit === Infinity ? pairs.length : limit);
  console.log(`model: ${engine.model}   pairs: ${selected.length}/${pairs.length}   excluded families: ${excluded.join(", ") || "none"}`);
  console.log(`majority-guess baseline on singletons: ${(baseline.rate * 100).toFixed(0)}% — the number a model that knows nothing scores\n`);

  /**
   * Score a list of contrastive pairs under all three conditions. Shared by the
   * family questions and the corpus-derived ones so a difference between the two
   * sets can only come from the questions, never from how they were scored.
   */
  async function scorePairs(list, label) {
    const scored = [];
    for (const [i, p] of list.entries()) {
      const halves = [];
      for (const side of [p.a, p.b]) {
        const q = question(p.family, side.project, p.options);

        // A — the real path
        const withCtx = await askUserModel(store, {
          question: q, asker: "bench", source: "cli",
          provenance: { kind: "local", surface: "cli" }, allowed: null,
          project: side.project, // conventions are project-scoped
        }, engine);

        // B — the counterfactual: same model, no knowledge of this user
        let bare = "";
        try {
          const raw = await engine.extract({
            model: engine.model, instruction: BARE_INSTRUCTION,
            schema: ANSWER_SCHEMA, content: q, maxTokens: 300,
          });
          bare = typeof raw?.answer === "string" ? raw.answer : JSON.stringify(raw ?? "");
        } catch { bare = ""; }

        halves.push({
          project: basename(side.project), expected: side.answer, evidence: side.evidence,
          a: { ...grade(withCtx.answer, side.answer, p.options), confidence: withCtx.confidence, deferred: withCtx.deferred },
          b: grade(bare, side.answer, p.options),
        });
      }
      const pairA = gradePair(halves[0].a, halves[1].a);
      const pairB = gradePair(halves[0].b, halves[1].b);
      scored.push({ family: p.family, blindSpot: p.blindSpot ?? false, halves, pairA, pairB });
      console.log(
        `${label} ${String(i + 1).padStart(2)}. ${p.blindSpot ? "[blind] " : ""}` +
        `${halves[0].project}=${halves[0].expected} / ${halves[1].project}=${halves[1].expected}   ` +
        `persnally:${pairA ? "PASS" : "fail"}  no-context:${pairB ? "PASS" : "fail"}`,
      );
    }
    return scored;
  }

  const rows = await scorePairs(selected, "fam");
  const corpusLimited = corpus.pairs.slice(0, limit === Infinity ? corpus.pairs.length : limit);
  const corpusRows = corpusLimited.length ? await scorePairs(corpusLimited, "cor") : [];

  // C — withheld: a project the store has never seen. A refusal is the only
  // correct answer, and a confident guess here is the product lying.
  const withheldQs = [
    { family: "package manager", project: "zzz-nonexistent-repo" },
    { family: "test runner", project: "another-unknown-project" },
  ].map(({ family, project }) => {
    const options = familyOptions(family);
    return {
      options,
      text: `${family}: Which one does this user use in the "${project}" project? Options: ${options.join(", ")}.`,
    };
  });
  const withheld = [];
  for (const { text: q, options } of withheldQs) {
    const r = await askUserModel(store, {
      question: q, asker: "bench", source: "cli",
      provenance: { kind: "local", surface: "cli" }, allowed: null,
      project: "/nonexistent/withheld-project",
    }, engine);
    const g = grade(r.answer, NO_CORRECT_ANSWER, options);
    // Honest = refused, or answered below the deferral threshold.
    withheld.push({ question: q.slice(0, 40), honest: g.verdict === "refused" || r.deferred, verdict: g.verdict, confidence: r.confidence });
  }

  const flat = (k) => rows.flatMap((r) => r.halves.map((h) => h[k]));
  const report = {
    model: engine.model,
    pairs: { total: rows.length, persnally: rows.filter((r) => r.pairA).length, noContext: rows.filter((r) => r.pairB).length },
    halves: { persnally: tally(flat("a")), noContext: tally(flat("b")) },
    majorityBaseline: baseline,
    withheld: { total: withheld.length, honest: withheld.filter((w) => w.honest).length, detail: withheld },
    excludedFamilies: excluded,
    corpus: {
      total: corpusRows.length,
      persnally: corpusRows.filter((r) => r.pairA).length,
      noContext: corpusRows.filter((r) => r.pairB).length,
      blindSpots: {
        total: corpusRows.filter((r) => r.blindSpot).length,
        persnally: corpusRows.filter((r) => r.blindSpot && r.pairA).length,
      },
      cappedAway: corpus.dropped,
    },
    // Per-half detail: a score says how it did, this says where it failed.
    rows: rows.map((r) => ({
      family: r.family,
      pair: { persnally: r.pairA, noContext: r.pairB },
      halves: r.halves.map((h) => ({
        project: h.project, expected: h.expected, evidence: h.evidence,
        persnally: { verdict: h.a.verdict, asserted: h.a.asserted ?? null, confidence: h.a.confidence, deferred: h.a.deferred },
        noContext: { verdict: h.b.verdict, asserted: h.b.asserted ?? null },
      })),
    })),
  };

  const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(0)}%` : "n/a");
  console.log(`\n${"=".repeat(64)}`);
  console.log(`PAIR ACCURACY   with Persnally  ${pct(report.pairs.persnally, report.pairs.total)}  (${report.pairs.persnally}/${report.pairs.total})`);
  console.log(`                no context     ${pct(report.pairs.noContext, report.pairs.total)}  (${report.pairs.noContext}/${report.pairs.total})`);
  console.log(`HONESTY         refused when it had no evidence  ${pct(report.withheld.honest, report.withheld.total)}  (${report.withheld.honest}/${report.withheld.total})`);
  if (report.corpus.total) {
    console.log(`\nCORPUS QUESTIONS (derived from the command log, not from our rule table)`);
    console.log(`                with Persnally  ${pct(report.corpus.persnally, report.corpus.total)}  (${report.corpus.persnally}/${report.corpus.total})`);
    console.log(`                of which outside the rule table  ${pct(report.corpus.blindSpots.persnally, report.corpus.blindSpots.total)}  (${report.corpus.blindSpots.persnally}/${report.corpus.blindSpots.total})`);
  }
  const unanswered = report.rows.flatMap((r) => r.halves
    .filter((h) => h.persnally.verdict !== "correct")
    .map((h) => `${r.family}/${h.project} (${h.persnally.verdict}, expected ${h.expected}, ${h.evidence} invocations)`));
  if (unanswered.length) {
    console.log(`\nCOULD NOT ANSWER (evidence exists, Persnally did not serve it):`);
    for (const u of unanswered) console.log(`  - ${u}`);
  }
  console.log(`\nper-half  persnally: ${JSON.stringify(report.halves.persnally)}`);
  console.log(`          no-context: ${JSON.stringify(report.halves.noContext)}`);
  console.log("=".repeat(64));

  if (jsonOut) { writeFileSync(jsonOut, JSON.stringify(report, null, 2)); console.log(`wrote ${jsonOut}`); }
  store.close();
  rmSync(dir, { recursive: true, force: true });
}

await main();
