# Context Depth — the Voice & Convention layer

> Spec. The bet: **"richest context" = the model that changes the AI's output the most per token injected**, measured by output quality (did Cursor write the PR in my voice?), not by event count. Today's store is interest-centric (topics + occasional assertions); this adds the fine-grained, prescriptive layer that makes connected tools answer *like they know you*. This is the depth that turns generic assistance into output that feels personal.

## Principle: capture small, store distilled, serve prescriptive

Three failure modes to avoid:
1. **Spam** — storing every micro-observation forever → noise, no signal. → store granular evidence, but consolidate to a *small set of stable constants*; decay fades old habits; corrections override.
2. **Descriptive-not-prescriptive** — "interested in Rust" doesn't change output. → every served line is an *instruction for the AI about the user*, not biography.
3. **Capture without serving** — fingerprinting is pointless unless a tool consumes it. → the loop closes only at the `persnally_context` voice/convention packs.

## Schema — `signal.style`

New event type (alongside `signal.topic` / `signal.assertion`). Structured so it dedupes and consolidates cleanly:

```ts
"signal.style": z.object({
  dimension: z.enum(["voice", "convention", "emphasis", "format", "workflow"]),
  pattern: z.string().min(1),       // canonical, dedupe key — e.g. "terse", "no emoji",
                                     // "pnpm over npm", "phrase:and so on", "wants falsification first"
  polarity: z.enum(["does", "avoids", "prefers", "insists"]),
  confidence: z.number().min(0).max(1),
  evidence: z.string(),             // a quote or a count ("47× across 210 prompts")
  basis: z.enum(["observed", "stylometry", "correction"]),  // where it came from
})
```

Dimensions:
- **voice** — terse/verbose, hedging, directness, repeated phrases/tics, politeness markers.
- **format** — bullets vs prose, emoji, code-first, sentence length, casing ("i" lowercase).
- **convention** — pnpm over npm, vitest, no default exports, small commits, TS strict.
- **emphasis** — what they repeatedly insist on: "wants the falsification first", "minimal beats clever", "be 100% sure", "don't experiment with X".
- **workflow** — kills ideas fast, asks for the case-against, prototype→measure→delete.

`signal.assertion` kinds `preference`/`behavior` stay for free-text claims; `signal.style` is the structured, dedupe-able layer. `user.correction` already exists — wire it to write/boost a `signal.style` of basis `correction`.

## Capture — two engines

**1. Deterministic local stylometry (zero tokens, fully local).** A pass over the user's *own* messages (Claude Code prompts + chat exports — already imported) computes, with no LLM:
- distinctive repeated phrases (n-grams ranked by frequency → the catchphrases/tics)
- distinctive content words (frequency minus a stopword baseline)
- sentence stats: median length, question rate, directive-opener rate, hedging rate
- format/tone: emoji rate, exclamation rate, ALL-CAPS emphasis, "i" lowercasing, bullets vs prose, type/token vocabulary richness

Emits `signal.style` events (basis `stylometry`). This is the richest-per-cost signal available and the most on-thesis (nothing leaves the machine).

**Shipped** in `persnallyd/src/stylometry.ts` (voice/format/tone) and `persnallyd/src/workflow.ts` (convention/workflow, mined from shell commands). `experiments/voice_fingerprint.mjs` remains the exploratory tool — it prints the raw ranked n-grams the shipped extractor turns into signals, which is what makes corpus problems visible.

> **Corpus hygiene (required, and harder than it looks).** Raw human prompts are polluted by pasted data — file paths, URLs, JSON/logs, and injected blocks (`<task-notification>`, command palettes, tool output). Unfiltered, that noise *swamps* the voice signal: the prototype's first run surfaced "tmp claude 501 users" and "task notification task id" as top "phrases". A `prose()` filter — strip injected blocks + fenced code, drop lines that are path/URL/data-shaped or lack a function word — recovered real tics like "be 100% sure".
>
> **That filter was still wrong, quietly.** It matched an injected block with a non-greedy run to *any* closing tag, so `<task-notification>` ended at the first nested `</task-id>` and the rest of the block survived as "prose". The top three tics on a 2026-08 run were Claude Code's own rate-limit text ("hit your session limit", 244×). The tag must be back-referenced (`<\/\1>`) and the strip repeated until stable. Removing it dropped 141 of 1,216 prompts and the ranking became genuine voice.
>
> **The importer still lacks this.** `importers/claude-code.ts` strips `<system-reminder>` and drops `<command-*>`-prefixed turns, but passes `<task-notification>` blocks through into `userMessages` — so `signal.topic` extraction and the LLM profile still see that garbage. The shipped style output is clean today because the LLM extractor tolerates it, not because the corpus is. Fixing import hygiene lifts the whole pipeline.

**2. Zero-cost live capture via MCP.** Extend `persnally_track` with an optional `style[]` array so the connected AI — already reading the conversation — emits the voice/convention/emphasis signals it observes. No extra inference (the "Claude is the NLP engine" trick, past topics). The model is told: only emit a style signal on a *clear, repeated* tell, not every message (anti-spam at the source).

## Consolidation — distill to constants

The nightly pass (`consolidate.ts`) already exists. Extend it to:
- dedupe `signal.style` by canonical `pattern`; merge confidence/counts.
- decay: a habit not re-observed fades; a re-observed one strengthens.
- `correction` basis overrides `observed`/`stylometry` for the same pattern.
- output a capped set (~10 voice + ~10 convention) — the served essence, not the raw log.

## Serving — prescriptive packs

New `persnally_context` scopes, system-prompt-ready:

- **voice** → *"Write like this user: terse, no emoji, bullets over prose, no filler, direct imperatives, rarely hedges, says 'and so on' / 'doesn't make sense'."*
- **conventions** → *"Their rules: TypeScript · SQLite · pnpm · vitest · no default exports · small commits · wants the falsification first · minimal beats clever."*

Dashboard gets a **"Voice & conventions"** section (evidence-linked, deletable) — and it's a strong dashboard wow ("it knows I say 'and so on'").

## Trust

Every served line traces to evidence (quote or count) and is deletable. Stylometry is deterministic → fully auditable ("you say X 47 times, here are 3"). Honors the local-first custody promise: the fingerprint never leaves the machine.

## Phasing (smallest-slice-first)

1. **Stylometry pass** (the prototype) → `signal.style` (basis stylometry) → a `voice` pack + dashboard section. No schema upheaval beyond the one type; no tokens. *Proves the whole thesis cheaply.*
2. **Enrich `persnally_track`** for live `style[]` capture.
3. **Consolidation distillation + `user.correction` wiring** (the self-correcting loop).

## Open questions

- Stylometry baseline: rank distinctive words against a generic English frequency list, or just stopword-filter + raw frequency? (Prototype starts with stopword-filter; upgrade to TF-IDF vs baseline if needed.)
- Per-context voice: do you write differently in code vs chat? (Source-scoped fingerprints later; one global voice first.)
- Pack size: how many lines before a system prompt gets diluted? (Start ~10/pack; tune by measuring output change.)
