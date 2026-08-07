# Persnally v2 — Architecture of Record

> The product wins through structural properties, not features. Every PR should be
> auditable against the invariants below. Schema detail: [EVENT_SCHEMA.md](./EVENT_SCHEMA.md).
> Roadmap: [../ROADMAP.md](../ROADMAP.md).

## Why the architecture is hard to replicate

| Property | Why it's hard for a cloud incumbent to match |
|---|---|
| Local-first | Memory-layer companies are cloud businesses; going local deletes their revenue model |
| Cross-vendor | Platform memory exists *to* lock in; vendors won't share user context with rivals |
| Provenance-complete | Memory trained into weights or summarized into blobs can never answer "why do you think this?" |
| Truly unlearnable | Hard-delete + re-derive requires an event-sourced core; retrofitting it is a rewrite |

A feature-clone built on a cloud aggregation store is a different product that loses
every trust argument. Boring technology, radical properties.

## Target topology

```
  AI clients (Claude, Cursor, agents...)        importers (claude, chatgpt, git...)
        │  MCP: persnally_context / persnally_track   │  parse (pure) → extract (LLM) → events
        ▼                                              ▼
  ┌─────────────────────────── persnallyd ─────────────────────────────┐
  │   EVENT LOG (SQLite/WAL) ──── the only source of truth             │
  │        │                                                           │
  │        ▼ extractors (decay, assertions, skills, style)             │
  │        ▼ (planned: a learned behavior model — see rung 2 below)    │
  │   DERIVED VIEWS (topics, profile, voice, …) ── always re-derivable │
  │        ▲                                                           │
  │   hard-delete walks the provenance graph, then re-derives          │
  └───────────────┬────────────────────────────────────────────────────┘
                  │ loopback HTTP, credentialed — the single access path
        dashboard · CLI · (Phase 4: E2E-encrypted sync; cloud never sees plaintext)
```

## The nine invariants

1. **The event log is the single source of truth.** Views are cattle; events are sacred.
   This makes unlearning, schema migration (drop-and-rederive), and audit free, not features.
2. **Every derived claim cites its evidence.** Provenance is a walkable graph; "why does
   it think this?" is a lookup, never an LLM guess.
3. **Deletion is first-class and total** — matching events plus derived descendants, then
   rebuild. No tombstones carrying content.
4. **One write path.** The daemon owns the database. MCP server, CLI, and dashboard are
   clients of the daemon, never of the file.
5. **Protocols are adapters, not foundations.** MCP is a thin edge file; if the protocol
   landscape shifts, the edge is re-skinned in days and the core never knows.
6. **Deterministic core, LLM at the edges.** Models run at ingest (extraction) and synthesis
   (profile/reflection). **Context reads are deterministic** — instant, free, offline —
   because an agent consulting context cannot pay model latency per consult. The one
   exception is `persnally_ask`, which reasons over the corpus at query time by design and is
   therefore rate-limited and never on the session-start path.
7. **Closed, versioned event types.** Unknown types fail loudly. Payload changes bump
   versions; migrations re-derive views.
8. **Minimal dependency surface.** Runtime deps: `better-sqlite3`, `zod`,
   `@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`. Each absent dependency is
   supply-chain risk and upgrade tax we don't pay.
9. **No ambient access.** Loopback binding is not a credential — the port is reachable by
   every process and every user on the machine. Every route except `/health` requires
   either the owner's dashboard session (minted from a key in the mode-0600 config) or a
   client's identity token, and a client token reaches only the routes an AI needs. Custody
   we can't demonstrate isn't custody.

## How it learns (agentic / RAG / feedback / "daily training")

- **Agents consume us; the core is not agentic.** We serve agents (`persnally_context`,
  `persnally_ask`, `persnally_search`); we use bounded LLM passes at the edges; reads never
  think — except `persnally_ask`, which is the one deliberate exception (see rung 2).
- **RAG: we are the R.** From every client's perspective Persnally is the retrieval layer
  for the user. Structured retrieval (weights, kinds, time) is built, and `persnally_search`
  does targeted lookup by deterministic token overlap — offline, no index to maintain, which
  is the right call at store sizes in the thousands of events. Embeddings would arrive as a
  derived view (re-derivable, local, deletable) only when that stops being enough; nothing
  today needs them.
- **The feedback loop is first-class in the schema, and closed:** `feedback.signal`
  (approved/edited/vetoed), `user.correction` (highest authority — outranks any inference),
  `context.read` (what actually gets consumed). Every judgment is a labeled example recorded
  as an event, and both corrections and rejected answers feed straight back into the material
  `persnally_ask` reasons over. What the loop lacks is throughput, not wiring: organic capture
  measured 3%, so the stream is import-fed, and the precision stat has a sample of one person.
- **Learning happens in data space, never weight space.** No fine-tuning on user data:
  trained weights can't cite evidence (breaks #2) or unlearn (breaks #3). Instead the
  engine learns by re-derivation — new events in, extractors re-run, decay shifts,
  corrections override, profile re-synthesizes. Same "trained daily" outcome; inspectable,
  reversible, cheap.
- **Nightly consolidation (shipped):** the daemon checks every 30 minutes and reflects once
  a day at 3am local — refreshes decay, emits at most 3 `signal.assertion` events of kind
  `behavior` over signals new since the last pass (provenance: derived from the events
  considered), prunes the style backlog, and re-synthesizes the profile when enough changed.
  Sleep consolidation, locally, while the user sleeps.

## The behavioral model trajectory

The north star: a model of the user faithful enough to guide — and eventually act — from
*their* lens. It is built out of this architecture, not beside it:

- **Descriptive (rung 1, shipped):** the synthesized profile, the decayed interest graph,
  and the voice layer — how the user works, decides and writes, every claim citing events.
- **Predictive (rung 2, partially shipped — and read this precisely):** `persnally_ask`
  answers "what would they do?" today, but **there is no learned model**. It assembles an
  evidence corpus at query time (decayed topics, profile, assertions, corrections, rejected
  past answers, voice pack) and has a frontier model reason over it, with a 0.7 confidence
  floor below which it defers to the human. Nothing is fit, and nothing accumulates in
  parameters — the "model of you" is the corpus plus the reasoning, re-derived every call.
  That is a deliberate choice, not a placeholder: it inherits every frontier-model
  improvement for free, stays fully inspectable, and honors invariant #2 (weights can't cite
  evidence). A learned model earns its place only if it beats this, measured — and it cannot
  be measured before there are users. **The behavior model is downstream of distribution.**
- **Prescriptive (rung 3, not built):** acts on the user's behalf, or volunteers suggestions
  to the human. No code exists for this and none should until fidelity is measured — a wrong
  proactive suggestion costs more trust than a hundred right answers earn.
- **The eval harness (Phase 3 deliverable, not built):** hold out real decisions the user
  made; the model predicts them blind; agreement is scored. Today the only fidelity
  instrument is the dashboard's precision stat (approved / labeled, where an edit counts
  against). A harness needs an eval set: it is worth building at roughly 100+ judged answers
  across several people, and is theater before that. "Realistic like me" must be a number
  that goes up, or it's marketing.

Capture rule that protects this future: **record at decision granularity** — a choice
made, an option rejected — not only topic summaries. Over-aggregation at ingest is the
one mistake the future model cannot undo.

## Current state vs target (2026-08-06)

**Standing, tested, CI-gated** (223 tests + MCP protocol e2e, strict `tsc`, install matrix
across macOS/Ubuntu/Windows × Node 22, the engines.node floor): event log (UUIDv7, closed 10-type set v1) ·
importers for claude, claude-code, chatgpt and git, each with provenance · decay extraction ·
deterministic stylometry + voice layer · profile synthesis with evidence citations, plus
per-scope profiles · re-derivable versioned views · loopback daemon with credentialed access ·
dashboard · CLI · MCP adapter exposing 6 tools · per-client identity tokens and category
scopes · nightly consolidation · background incremental import of new Claude Code sessions ·
the `persnally_ask` decision loop with a confidence floor · the feedback loop
(`feedback.signal`, `user.correction`) wired back into ask material.

**Resolved since the last revision:** the dual source of truth (MCP v2 is a thin daemon
client; the v1 graph migrates once) · daemon lifecycle (pidfile, `stop`, launchd/systemd
autostart) · unauthenticated local access (invariant #9) · the hot-path derived reads
(dashboard poll 90ms → 10ms on a 45k-event store).

**Known gaps, in order of architectural urgency:**

1. **No retention policy on event growth.** Only `signal.style` is bounded (pruned nightly).
   `context.read`, the ask/answer/feedback trio, topics, assertions and `system.import` grow
   for the life of the install. Constant factors on the read paths are now good, but the
   underlying growth is unbounded — the structural fix is compaction that preserves
   invariants #1–#3, and it is not designed yet.
2. **`rebuild()` is O(all topic signals).** Inherent rather than sloppy: decay is per-signal
   and time-dependent, so a full re-derive is the correct semantics, and it runs on every
   tracked write. Measured at ~25ms over 8k topic signals. Incremental derivation would need
   to reproduce decay exactly; don't build features that assume rebuilds stay free.
3. **No encryption at rest.** Acceptable while everything is local; it is a hard prerequisite
   for Phase 4 sync, which requires E2E encryption with user-held keys (cloud never sees
   plaintext).
4. **CLI opens the db directly.** Acceptable while single-user and local — both processes use
   WAL with a busy timeout — but invariant #4 isn't literally true of the CLI yet.
5. **Destructive wipe is reachable with any client token.** `persnally_forget`'s clear-all is
   part of the MCP tool contract, so a category-scoped client that cannot *read* everything
   can still *delete* everything. A stated decision is owed here either way.
6. **No automated performance gate.** Perf work has been verified by ad-hoc benchmarking; one
   rewrite was 20× slower than what it replaced and passed the full suite. The only
   structural guard is an `EXPLAIN QUERY PLAN` assertion on the `recorded_at` index.
