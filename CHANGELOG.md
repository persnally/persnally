# Changelog

All notable changes to Persnally will be documented in this file.

## [3.2.0] - 2026-09-04

Your agents can now trust what Persnally answers, because an answer is only as confident as the evidence behind it. Cursor and Codex join the import sources, so an agent-CLI developer's whole history is finally visible to their own context engine. The workspace dashboard ships on `/next`, and Persnally installs into Claude Code as a plugin.

### Added

- **Cursor and Codex as import sources.** Both were *connect* targets and neither was an *import* source, so a Cursor- or Codex-primary developer imported nothing but git — every prompt they had ever written to an AI was invisible to their own context engine. Cursor's history lives in the SQLite database the app writes for its own UI (`state.vscdb`, keyed for Electron's blob store rather than for reading); Codex's lives in rollout JSONL shared across its CLI, desktop app and IDE extension. Every shape both importers assume was read out of real data on a machine that uses them, because neither format is documented. Two things in the real data were not guessable: a Codex `exec` tool call's `input` is a JS snippet the model wrote rather than a JSON object, and a `thread_source: "subagent"` session is a safety-review subthread whose "user" turns are the parent transcript being fed in for review — importing it would have credited you with prompts you never wrote.
- **Incremental top-up for Cursor and Codex.** Only Claude Code could resume a conversation; the others re-paid to re-extract their whole history on every pass. All three now share one watermark engine, so a fourth source costs a config object rather than a fourth copy of the logic. Codex carries per-message ids and timestamps, the same precision Claude Code has; Cursor's bubbles carry no timestamp at all (verified against ~2,000 real ones), so it falls back to the composer's own `lastUpdatedAt` rather than pretending to a precision the data does not have.
- **Context at session start for every MCP client, through one protocol field.** Claude Code has a SessionStart hook; Cursor, Claude Desktop, Codex, Windsurf, Zed and VS Code do not. Rather than one mechanism per client, the MCP `instructions` field — returned in the initialize result — carries your context before the first message. Cursor demonstrably reads it. One field, no per-client code, and a client that ships tomorrow works without us. Content comes from `GET /context`, the same serving path as the hook and the tool, so this channel cannot drift from them or skip its receipt.
- **The workspace dashboard, on `/next`.** A collapsible rail over five areas with the Mirror fully built: the evidence-linked portrait, a per-section provenance walk, and an ask composer that calls the same `POST /ask` agents call over MCP. Preact and Vite compiled to a single 36KB file, so the daemon still serves exactly one cached HTML string — no static routes and nothing new on the hardened auth path. The classic page stays byte-untouched at `/` until parity; the honesty invariants (demo data only with `?demo=1`, a 401 resolving to signed-out and never to demo) are carried over and test-enforced.
- **A Claude Code plugin.** `/plugin marketplace add persnally/persnally` then `/plugin install persnally@persnally` installs the SessionStart hook and a `/persnally:setup` skill that installs and verifies Persnally non-interactively. The MCP server deliberately stays behind `persnally connect`: every client presents an identity token minted into its own config, and a plugin manifest shared across installs cannot carry a per-install secret. `connect` now detects an installed, enabled plugin whose manifest carries our hook and skips writing a second one.
- **A benchmark for the ask loop.** Three conditions per question — with Persnally, the same model with no context, and Persnally asked about a project it has no data for, where the only right answer is a refusal. Deterministic grading, no LLM judge, because on the flagship long-term-memory benchmark judges pass vague-but-wrong answers 63% of the time. Reproducible for free against your own history with a local model: `node bench/run.mjs --engine=ollama`.

### Changed

- **An answer's confidence now comes from its evidence, not from the model's self-report.** Measured on a real store: a capable model answered "pnpm" at 0.92 for a repo whose transcripts run `npm` 185 times, and a 3B local model answered both questions it had no evidence for at 0.9. Confidence is now the lesser of what the model claims and what the cited events can bear — a correction you stated backs anything, an observed convention exactly what its count earned, a model's reading of prose 0.65, nothing cited 0.6. The last two sit under the deferral threshold, so those answers go back to you. A citation is also checked against the answer: the first tool an answer names must be backed, nothing else it names may contradict the strongest convention observed in that repo, and a text that names the alternative ("prefers merge over rebase", "uses npm, never pnpm") is not a vote for it. On the benchmark this moved 21/26 with five confident errors to **26/26 with none**, and the small local model from fifteen confident errors to deferring instead.
- **Conventions are derived from a workspace's whole command history, not from one import batch.** The daemon's incremental imports mined each batch alone, so a habit spread thinly across many sessions never cleared the noise floor inside any single one — a repo with 185 `npm` invocations had no `npm` convention on file, and a stale prose claim answered in its place. Every workspace's conventions are now re-derived from all three local transcript sources after each import and nightly. Deterministic, no tokens.
- **What you ran outranks what a model read about you.** `toolConventions` computed a count and a confidence for every convention and both were dropped at serve time, so a claim a model once extracted from prose was rendered *with* its confidence while hundreds of observed invocations in the very project being asked about were rendered as a bare bullet. Conventions are now served with their counts and labelled as observed; extracted claims are labelled as a model's reading that may be stale and served after them.
- **Interests are folded, so one topic phrased three ways is one topic.** Extraction renames an interest each time it sees it, so on a real 3,199-event store the three strongest entries were one topic under three names and a fourth was spread across fourteen variants — diluting exactly what `get_context` serves. Folding happens in the derived view only: the log stays append-only, every constituent event keeps its provenance, and a folded phrasing stays searchable. Calibrated to under-merge deliberately, because a wrong merge is a false claim about you while a missed one is only redundancy.
- **`persnally forget` resolves a merged row whole.** A partial delete would have reported success while leaving the topic on screen.
- **The product says what it is in one sentence.** "A model of you, built from your own AI history, on your machine. Every AI you use reads it." The daemon is still a context engine; that phrase is no longer the headline. The engine is **source-available** under FSL-1.1-MIT rather than open source, stated plainly, and inference is described as running fully offline with Ollama before any mention of a key.

### Fixed

- **Every context read is recorded, and credited to the client that read it.** `persnally_ask` — the richest disclosure path in the product, sending profile, assertions, corrections and voice into a model — recorded nothing at all, so it was invisible to both the receipts feed and the north-star metric it is meant to drive. `persnally_interests` recorded nothing either; showing you your own profile is still a disclosure of it. And the SessionStart hook wrote `source: "cli"`, so every Claude Code session was attributed to you reading yourself, which is why the read log rendered as a wall of "you · CLI" while the access matrix looked empty. A hook read is now recorded as performed by the CLI and consumed by the client whose session it is: `source` becomes `hook:<client>`. Already-installed hooks attribute correctly without reinstalling.
- **`--reextract` refuses to run when the engine looks broken.** It deletes a batch and replaces it, so a dead engine turned a rich import into a thin one permanently. It now refuses when every extraction in the run failed, rather than silently downgrading real signal. This is not hypothetical: an exhausted key mid-`--reextract` replaced 1,366 real events with 59 on a maintainer's own store.
- **A conversation that genuinely has nothing topic-worthy stops being retried forever.** Only `signal.topic` marked a conversation as seen, so one a working engine looked at and found nothing in was indistinguishable from one never attempted — and was re-offered to extraction on every future import, at real token cost, forever. A `system.conversation_processed` event now records that it was looked at, whatever was found.
- **Tool counting reads the command, not the text.** `rg pnpm package.json` — ripgrep searching *for* the string "pnpm" — counted as pnpm usage, and a heredoc body counted as commands being run. Each pipeline segment is now classified by the executable it actually invokes, with `sudo`, `npx`, `xargs` and `python -m` delegating to the tool they run, and segmentation is quote-aware.
- **An engine reply that cannot be parsed defers instead of throwing.** A local model returning its confidence as `85` rather than `0.85` propagated a validation error out of the ask path; a percentage is now read as one, and anything unusable is recorded as a deferral.
- **The daemon runs all three importers per tick against one engine**, stopping at the first engine failure rather than paying the fail-fast cost once per source.

### Security

- **A revoked client could still read your conventions.** Renderers gated only their category-tagged sections on the grant, so the sections with no category — writing style, project conventions — were served to a client whose grant was empty. The check now lives where context is assembled rather than being re-remembered per route, and `/ask` and `/context` both honour it.
- **The ask path is scoped to the project it is asked about.** Project-scoping made `voice()` withhold *another* project's conventions; the ask path passed no project, so it withheld every one of them. Fixed, and the evidence now states which repo it is scoped to, since an unlabelled "prefers npm over pnpm" leaves a model unable to tell whether it applies to the repo in the question.
- Transitive dependency advisories picked up: `fast-uri` 3.1.7 (host confusion and SSRF via URI normalization) and `qs` 6.16.0 (array-limit bypass, attacker-controlled `isBuffer` denial of service).

## [3.1.0] - 2026-08-10

Persnally now tells you when it is broken, connects to eight AI clients instead of three, and can be installed end to end by an agent.

### Added

- **`persnally doctor`.** Being invisible after day one is the design goal; the cost is that breakage is invisible too. Three real failures on a maintainer's machine went unnoticed: the CLI lost its executable bit and every command died with `permission denied`; the daemon ran the previous version for a day after an upgrade, so none of that release's security fixes were active; and live capture stopped for two days across heavy use without a signal anywhere. `doctor` checks the binaries resolve and are executable, that the daemon is reachable *and on the same version as the CLI*, that Claude Code sessions are not newer than the last context read, the SessionStart hook, and the extraction engine. Exit is non-zero only on failure, and `--json` is available for scripts. `status` prints the one-line problems too, because nobody runs a diagnostic for a fault they have no reason to suspect.
- **Five more clients: Codex CLI, Gemini CLI, Windsurf, Zed and VS Code.** They agree on stdio and little else, so each config shape is written the way that vendor documents it — Zed nests `command` as an object, VS Code requires an explicit `type`, and Codex is TOML rather than JSON. `persnally connect --all` now covers eight clients and still skips the ones you do not have. ChatGPT remains unreachable by design: its connectors require a public HTTPS endpoint, and the daemon is loopback-only. Your ChatGPT *history* still imports.
- **Unattended setup for agents.** `persnally setup --yes` consents to the local model download without a terminal, and `--engine ollama|anthropic|none` forces the extractor. Previously the only non-interactive outcome was the degraded one. `--engine none` is a real choice: git history and writing style import fully offline.
- **`docs/AGENT_INSTALL.md` and `llms.txt`.** The likeliest installer of a personal context engine is the user's own AI. The guide is written for a machine — deterministic commands, a failure-mode table, and explicit rules: never `sudo`, never hand-edit the event store, and never report success without running `doctor`.
- **`persnally config set-key` reads stdin** when given no argument, so a key need not appear in `ps` output or shell history.

### Changed

- **A forced engine is now honoured strictly and never falls back.** `--engine ollama` on a machine with `ANTHROPIC_API_KEY` set previously resolved to the Anthropic extractor and sent conversation text off the machine — the opposite of what was asked, in the product where that matters most. Forced `anthropic` with no key now fails rather than silently using Ollama.
- The local dashboard carries the Persnally mark in its header and favicon, and its GitHub link points at the current repository.

### Fixed

- **A backslash before a pipe escaped its cell in the Markdown export.** `esc()` escaped the pipe but not the backslash, so `\|` became `\\|` — which Markdown reads as one literal backslash followed by a live cell separator. Topic names are client-writable through `persnally_track`, so a prompt-injected client could shape one to inject arbitrary Markdown into your own export. Present in 3.0.0.

## [3.0.0] - 2026-08-08

The daemon now authenticates every request, custody promises are enforced rather than asserted, and imports read several times more of your history than they did.

### Security

Loopback binding was never a credential — the port is reachable by every process and every user on the machine.

- **Every route requires a credential.** Only `/topics`, `/profile`, `/search`, `/ask`, and `POST /events` were checked before. Now `GET /events`, `/voice`, `/activity`, `/questions`, `/scopes`, `/stats`, `/engine`, `POST /synthesize`, `/consolidate`, `/engine/key`, `/feedback`, and every `DELETE` demand one too. `/health` stays open — it carries no store data and the startup probe needs it.
- **The dashboard authenticates with a session, not the open port.** `persnally dashboard` prints a link carrying a key from your mode-0600 config; the daemon exchanges it for an `HttpOnly; SameSite=Strict` cookie and redirects, so the key never lingers in the address bar, history, or a `Referer`.
- **A client token may only write events attributed to itself.** Writes claiming `cli` or `dashboard` provenance — the shape `persnally correct` produces — were accepted from any connected client. Since corrections are authoritative and outrank everything the engine inferred, one prompt-injected client could permanently rewrite what every other AI believed about you, rendered as your own words.
- **Revoked means revoked.** A revoked client could still read your full style pack (the most prescriptive layer), event counts, and the names of every other connected client — and could permanently tombstone voice patterns. All closed. A *scoped* client still gets style by design (it's how you write, not what about), and the dashboard now says so instead of implying otherwise.
- **Wiping everything is the owner's action alone.** Connect is default-open, so every freshly connected AI held the power to destroy your accumulated model irreversibly. `clear_all` is gone from the MCP surface entirely; clients keep per-topic and per-style forget.
- **Deleted data leaves no residue.** Without `secure_delete`, freed pages kept their bytes and `strings persnally.db` still found a topic you had forgotten. Now `secure_delete` + a WAL-truncating checkpoint + `VACUUM` on the full wipe. The provenance walk was also one hop and order-dependent, so a claim derived from a derived claim outlived its source; it now walks the whole chain.
- **The store, logs, and client tokens are owner-only.** The event store, its WAL, `daemon.log`, `telemetry.jsonl`, and the client configs carrying bearer tokens were all written world-readable (0644). Now 0700/0600, tightened on existing installs too.
- **The dashboard never shows a fabricated portrait.** With the daemon down it rendered sample data — a complete portrait of a person who doesn't exist — distinguished only by a grey dot. Sample data is now opt-in (`?demo=1`, used by the marketing preview alone); a real user gets told the daemon isn't running. Hallucinated evidence IDs are also pruned before a profile is stored, so a fabricated citation can no longer render as "evidence not found (deleted?)".

### Added

- **`persnally export [--md] [--out <file>]`** — take everything with you. The complete bundle (events, profile, interests, voice, corrections) as re-importable JSON, or a readable portrait. Ownership without portability was a claim; this makes it demonstrable.
- **`persnally import <source> <path> --reextract`** — re-run extraction over history already on file, replacing rather than doubling. Imports are stamped with an extractor version, and `persnally status` tells you when stored imports predate the current one. Without this, every extraction improvement would only ever apply to new conversations.
- **Conventions and workflow from your shell commands.** Which package manager, which test runner, rebase or merge, PRs from the CLI — mined deterministically from Claude Code sessions at zero token cost. The `convention` and `workflow` dimensions existed in the schema and were rendered by the dashboard, but nothing produced either.
- **Demonstrated skills.** `signal.skill` had a producer and no reader anywhere; it now reaches the profile, `persnally_context`, and a new `GET /skills`.
- **Full-text search.** Retrieval is backed by SQLite's FTS5: stemming ("tests" finds "testing"), prefixes ("postgres" finds "PostgreSQL"), and bm25 ranking so a distinctive term outranks a common one. Previously literal substring matching, which also matched "rust" inside "trusted".

### Changed

- **Breaking: Node 20 is no longer supported** (`engines.node: >=22`). Node 20 is end-of-life and `better-sqlite3` 13.x requires >=22.
- **Breaking: clients never issued a token no longer get default-open access.** If a client 401s, run `persnally connect <client>` and restart it — the error says so.
- **Imports read far more of your history.** Extraction now sees the assistant's replies, not just your prompts — so what was *answered* and *decided* is visible, where before only the questions were. ChatGPT Custom Instructions (which you wrote about yourself) are parsed instead of dropped, Claude memory is re-read when it grows rather than captured once, and the git importer mines commit subjects and touched files instead of only dates — one repo now yields the areas you work in and the languages you write, not just its folder name.
- **Decay is per-category.** One 7-day half-life treated a career and a debugging session identically, collapsing a multi-year import into "whatever happened last week". Now career/health/finance 120d, business/creative/education/science/lifestyle 60d, technology 30d, news 7d — tunable via `decay_half_life_days` in config. Recency still ranks first; old signals are no longer erased. **Expect ranking to shift** on stores with deep history.
- **Dashboard sessions survive daemon restarts** and last 30 days with sliding renewal, instead of dying with the process and expiring hard at 12h. `persnally dashboard --rotate` still invalidates every session instantly. You'll re-authenticate once on upgrade.

### Fixed

- **A key-free setup no longer reports success over history it skipped.** With no API key, setup silently passed over your Claude/ChatGPT exports and printed "Done"; configuring an engine afterwards never went back for them. Setup now offers the local-model download in the terminal, names every skipped source, and the dashboard imports before synthesizing.
- **The nightly refresh stopped destroying export-derived voice.** It cleared all stylometry but could only re-derive from Claude Code transcripts, so voice fingerprinted from exports was permanently lost on the first nightly pass.
- **Resumed Claude Code sessions are picked up.** `claude --continue` appends to the same file, so once a session was imported every later message in it was invisible forever.
- `persnally --version` prints the version and exits 0 instead of dumping usage and exiting 1; one spelling of the binary name across every command you're told to type; live progress during long imports; `persnally ask` prints a dashboard link that actually opens; auto-open works on Linux and Windows, not just macOS.

## [2.10.0] - 2026-07-19

Identity gets real and imports get fast: connected AIs now prove who they are — so your scopes and revocations actually bind — and large exports land about 4× faster.

### Added
- **Per-client identity tokens.** `persnally connect` now issues each client a secret token (rotated on every connect) and pins its identity to it. The daemon refuses a client name that has a token but doesn't present it, refuses a token claiming another client's name, and holds event writes to the same rule — so a client can no longer read past its scope, ignore a revocation, or write events under another client's name by just claiming a different identity. Never-connected clients behave exactly as before; after upgrading, re-run `persnally connect` (or `setup`) once and restart your clients to turn enforcement on.

### Changed
- **Imports run in parallel.** Conversation extraction now processes up to 4 conversations concurrently (`PERSNALLY_IMPORT_CONCURRENCY` to tune, 1–16), roughly 4× faster on large exports — with output identical to a serial run and one bad conversation still never aborting the batch.
- `connect` prints a reminder to restart the client so it picks up its new identity token.
- MCP tools surface the daemon's actionable auth messages (e.g. "re-run `persnallyd connect cursor`") instead of a raw error dump.

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
