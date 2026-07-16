# Changelog

All notable changes to Persnally will be documented in this file.

## [2.9.0] - 2026-07-17

Your permission surface, complete — see and control exactly what each AI can read, from connect to revoke. And the interfaces others build against are now versioned open specs.

### Added
- **"What each AI can read" — dashboard access control.** Every connected client now shows on the dashboard with exactly what it may read (everything / limited to categories / revoked), and a one-click **revoke** and **restore**. Backed by new daemon endpoints (`POST /scopes`, `DELETE /scopes/:client`). Revoked means it reads *nothing* until you restore it.
- **Scope a client as you connect it.** `persnallyd connect cursor --scope technology,career` connects and limits the client in one step — no separate command afterward.
- **Versioned open specs.** The event schema ([docs/EVENT_SCHEMA.md](./docs/EVENT_SCHEMA.md)) and the MCP interface ([docs/MCP_INTERFACE.md](./docs/MCP_INTERFACE.md)) are now implementable, versioned contracts (spec 1.0, CC-BY) with stability policies and conformance criteria — build a compatible producer, consumer, or client from the docs alone. The schema doc is synced to the shipped code (adds the previously undocumented `signal.style` voice layer and `local` provenance).

## [2.8.0] - 2026-07-10

The context loop closes: your AIs consult your model, look things up, learn when you correct them, respect per-tool scopes with their own profile — and Linux joins macOS for autostart.

### Added
- **`persnally_search` — targeted lookup.** A new MCP tool (and `persnallyd search "<topic>"`) lets a connected AI look up what Persnally knows about a *specific* subject mid-conversation ("rust", "testing practices") instead of only the broad profile. Offline, deterministic, no LLM; returns nothing when the subject never appears in your history.
- **Corrections that stick.** When you correct something an AI believed about you, it records a `user.correction` (via `persnally_track`, or `persnallyd correct "<truth>" [--about <subject>]`). Corrections are **authoritative** — both the ask loop and profile synthesis weight them above anything inferred.
- **The ask loop learns from feedback.** Answers you mark wrong on the dashboard feed back into future answers as "don't repeat this"; approved ones don't.
- **Scoped clients get their own profile.** A client scoped to a subset of categories now receives a profile synthesized from *only* those categories — no cross-category narrative, assertions, or corrections leak through. Previously a scoped client lost `/profile` entirely.
- **Linux autostart.** `persnallyd autostart` now installs a systemd user unit on Linux (first-class alongside macOS launchd), with a `loginctl enable-linger` tip so the daemon survives logout.

### Changed
- The Claude Code SessionStart hook now nudges the session to call `persnally_ask` before interrupting you with a preference question — putting the loop in the default path.

### Security
- `POST /ask` is rate-limited (20 per 10-minute window) so a looping agent can't burn your inference budget.

## [2.7.0] - 2026-07-04

### Added
- **`persnally_ask` — agents ask your model instead of interrupting you.** A new MCP tool (the 5th) lets any connected agent ask questions about you — "would they want tests with this change?", "new dependency or hand-roll it?" — and get an answer synthesized from your accumulated history (profile, decayed interests, assertions, voice) with a confidence score. Below the confidence threshold it **defers**: the agent is told to ask you directly, never handed a guess. Also available as `persnallyd ask "<question>"` from the terminal.
- **"What your AIs asked" dashboard section.** Every question, answer, and deferral is recorded and shown with its confidence; you judge answers ✓ right / ✗ wrong, and a conservative precision stat (approved ÷ judged) tracks how often your model is actually right. Every exchange is an auditable event pair, same as everything else in the store.
- Daemon endpoints backing the loop: `POST /ask`, `GET /questions`, `POST /feedback`.

### Notes
- Scoped clients get answers built only from their allowed categories — the cross-category profile and assertions never leak past a scope, same boundary as `/profile`.
- An empty store or missing engine defers immediately without spending any inference.

## [2.6.2] - 2026-06-29

### Fixed
- "How you write" no longer picks up machine noise (pasted logs, command output) as style patterns — the stylometry corpus is cleaned before fingerprinting, and the voice pack re-derives on synthesize/reflect so stale patterns clear themselves.

## [2.6.1] - 2026-06-27

### Added
- **Local-first engine onboarding.** The dashboard walks a key-less install through its choices — save an Anthropic key, or pull a local Ollama model with one click (progress shown live) — so the mirror never dead-ends on "no engine."

### Changed
- Profile synthesis upgraded to Opus 4.8 by default.

## [2.6.0] - 2026-06-27

### Added
- **Shareable portrait card** — a "Share portrait" button on the dashboard generates a downloadable image of your self-portrait (archetype, top interests, voice, stats) with a mini interest-constellation. Rendered locally; you choose what's shown; nothing is uploaded.
- Plain-language intro line on the dashboard hero so first-time viewers immediately understand what they're looking at.

### Changed
- **Interest map redesigned** into a radial "you at the center" portrait — your interests radiate by strength in a curated amber palette, their entities branch off as leaf nodes; refined nodes (soft inner-light, no glossy bead), restrained glow, a deeper backdrop, and a subtle ambient drift. Category detail moved to the hover card + list view.

## [2.5.3] - 2026-06-25

### Added
- `persnallyd restart` — restarts the daemon correctly whether it's launchd-managed (unload + reload the job, which also heals a plist path that has drifted from the running process) or a plain background process. Ends the confusing "stop just respawns it" loop under autostart.

### Changed
- `start`, `restart`, and `setup` now print the dashboard URL **and** open it (macOS, interactive terminal); `autostart` prints the link. `stop` now points to `persnallyd restart` for a clean bounce.

## [2.5.2] - 2026-06-25

### Fixed
- Dashboard "since you last looked" strip: change items ran together with no separators, and the label floated to the middle when they wrapped to a second line. The label now sits on its own line and the items wrap as a clean `·`-separated row on desktop, stacking vertically on small screens for readability.

## [2.5.1] - 2026-06-25

### Fixed
- Retention pulse anchors the week-2 window to the **first context read** (when serving began), not onboarding — so a gap between setup and the first read reads as "in progress," not a false "not retained." For a fresh install (setup and first read minutes apart) the verdict is unchanged. Adds `firstReadAt` / `daysSinceFirstRead`.

## [2.5.0] - 2026-06-25

### Added
- **Retention pulse.** `persnallyd activity`, a `GET /activity` endpoint, and a dashboard engagement strip surface context-read activity over time: reads this week/month, distinct active days, a 14-day sparkline, and a week-2 retention verdict (≥1 read in days 8–14 after onboarding). Local/per-install only — it makes the otherwise-invisible "your AIs keep reading you" value visible, and it's the signal to watch on a fresh install or cold demo. Aggregate cross-user retention would require opt-in telemetry (deliberately not added).

## [2.4.0] - 2026-06-25

### Added
- **Mobile dashboard.** The interest constellation is now fully touch-driven (single-finger drag, pinch-to-zoom, tap-to-inspect, via pointer events), the layout reflows for phones, and narrow screens open to the topic list with the map one tap away. The trust surface is now usable on the device most launch traffic arrives on — it was inert on touch before.
- **Real provenance in the dashboard's "why?".** Each piece of evidence now names where it actually came from — the conversation it was imported from, the live client + session that recorded it, or the repo — instead of collapsing everything to a bare `mcp`/filename label.

### Fixed
- **Re-import is idempotent.** `persnallyd import claude|chatgpt|claude-code` now dedupes by conversation id and `import git` by repo, so re-running an import only adds genuinely new items instead of doubling every interest weight. (`setup` and the daemon auto-import were already safe; the explicit one-shot commands were not.)
- **Large exports fail clearly, not catastrophically.** An import file over 400 MB is refused with an actionable message instead of an opaque out-of-memory crash during `readFileSync`/`JSON.parse`.
- The dashboard footer now shows the running daemon version (was a permanently blank slot).
- Docs: corrected stale `get_context`/`record_event` tool names to `persnally_context`/`persnally_track` in `ARCHITECTURE.md` and `CONTEXT_DEPTH.md`; the README importer diagram now lists `claude-code`.

## [2.3.2] - 2026-06-21

### Added
- **Automatic capture of new chats** — the daemon now ingests new Claude Code sessions on its background loop (every 30 min, plus an immediate pass on startup), so your context keeps growing with zero action and no dependence on the model remembering to call `persnally_track`. Incremental: sessions already in the store are skipped by conversation id, so nothing is re-imported or duplicated.

### Fixed
- Import extraction is now resilient per conversation — a single malformed model response (e.g. an out-of-enum value) is skipped and retried on the next pass instead of aborting the entire import batch.

## [2.3.1] - 2026-06-20

### Fixed
- SessionStart hook now instructs Claude to call `persnally_track` at end-of-session — fixes 0% live capture rate where the model had context injected but no prompt to track signals back.

## [2.3.0] - 2026-06-21

> Note: `2.2.0` was published to npm but its release commit (version bump + this
> changelog entry) never landed on `dev` — a branch got abandoned mid-rework and
> the bump went with it. This entry covers everything shipped since `2.1.0`,
> including what `2.2.0` actually contained, so the record here matches reality.

### Added
- **Voice & convention layer** — a deterministic, zero-token stylometry pass over your own prose (repeated phrases, sentence tone, hedging, format) plus live capture as you chat via `persnally_track`'s `style[]`, distilled into a "voice" pack that `persnally_context` injects so connected tools answer in your style. New `signal.style` event type, `GET /voice`, `persnallyd voice` (offline refresh).
- **Deletable, for real** — forgetting a voice/style pattern (`DELETE /voice/:dimension/:pattern`, `persnally_forget`'s `style` param, `persnallyd forget --style`, or the `×` on a dashboard voice chip) writes a permanent correction so it stays forgotten even if stylometry or live capture would otherwise re-derive it. Nightly consolidation now also prunes the style backlog so live capture can't grow unbounded.
- **Redesigned local dashboard** — hero self-portrait, "since you last looked" deltas, "what your AIs read about you" receipts, reflections, a "How you write" voice section, and an interactive interest constellation.

### Fixed
- Import pipeline strips pasted paths/URLs/logs and injected blocks before extraction — cleaner topics and profile.
- A zip export that fails to read (missing `unzip`, corrupt archive, permission denied) during `persnally setup` is now surfaced, not silently treated as "no conversations found."

## [2.1.0] - 2026-06-20

### Added
- `persnally context [--full|--hook]` — emits your profile + interests for AI injection and records a context read (the serving path for the SessionStart hook).
- Auto-install of a Claude Code SessionStart hook on `connect` / `setup`, so every session injects your context automatically. Idempotent; leaves other tools' hooks untouched.

### Fixed
- Atomic config writes (temp file + rename) when registering MCP clients and installing the Claude Code hook — a crash mid-write can no longer corrupt a user's config.

> 2.0.0 (June 2026) was the v2 local-first rewrite — SQLite event store, loopback daemon, importers, embedded dashboard, daemon-backed MCP. The v1 entry below predates it.

## [1.0.0] - 2026-03-10

### Added
- MCP server with 5 tools: `persnally_track`, `persnally_interests`, `persnally_digest`, `persnally_config`, `persnally_forget`
- Interest graph engine with exponential decay (7-day half-life)
- Sentiment-aware topic weighting (negative sentiment deprioritizes)
- Depth scoring (mention, moderate, deep)
- Intent tracking (learning, building, researching, deciding, discussing, debugging)
- Topic normalization ("React.js" / "React JS" / "ReactJS" merge to single node)
- Balanced allocation across interest categories
- Atomic file writes with .tmp + rename pattern
- Backup recovery from .bak files
- Stale node pruning (every 50 signals)
- Digest API with background job processing
- API key and Supabase JWT authentication
- Interest graph → user profile conversion for curation engine
- Automated digest scheduler (hourly check, daily/weekly sends)
- Fresh content sourcing from GitHub Search API and HackerNews
- Synonym-aware relevance validation (46-domain synonym map)
- 120s pipeline timeout to prevent hung jobs
- TTL caching on external API calls (1-hour default)
- Web dashboard with onboarding, skill DNA, newsletters, preferences
- Landing page with MCP-native messaging
- Published to npm as `persnally`
