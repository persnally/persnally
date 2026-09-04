# Persnally

**So every AI finally knows you.**

Persnally builds **a model of you** from your own AI history, on your machine, and every AI you use reads it. It learns from your Claude and ChatGPT chats, your Claude Code, Cursor and Codex sessions, and your git; eight clients read the result over MCP today (Claude Code, Claude Desktop, Cursor, Codex, Gemini CLI, Windsurf, Zed, VS Code). ChatGPT imports today and reads live once the agent relay ships — it cannot reach a loopback server. Your tools stop treating you like a stranger.

Your context lives on your machine. Not in our cloud, not in any model vendor's silo. You can read every byte, see why it believes each thing, and delete any of it.

> **The giants build the intelligence. Persnally makes it yours.**

## Why

Every AI you use is brilliant and amnesiac. ChatGPT doesn't know what you told Claude. Your coding agent doesn't know your stack or your tolerances. Each one relearns you from zero, every session — or interrupts you to ask.

The fix isn't a better model. It's a layer underneath all of them that holds *you*: your interests, your projects, how you decide, what you're avoiding. The model vendors won't build this — they can't share your context with each other, and their business is keeping you inside their walls. So it has to be neutral, and it has to be yours.

## The five-minute wow

```bash
npm install -g persnally
persnally setup
```

One command builds your mirror: it finds Claude/ChatGPT exports in `~/Downloads`, reads your local Claude Code sessions and git repos, synthesizes an evidence-linked profile, connects your AI clients (Claude Code/Desktop, Cursor, Codex, Gemini CLI, Windsurf, Zed, VS Code), and opens the dashboard.

For the richest result, export your data first ([claude.ai](https://claude.com) / [chatgpt.com](https://chatgpt.com) → Settings → Data export) and drop it in `~/Downloads` — then read a description of yourself that's sharper than your own bio, every sentence traceable to the conversations it came from.

**Or have your AI do it.** Paste this into Claude Code, Codex, Gemini CLI, Cursor — anything that can run commands:

```
Set up Persnally on this machine for me. Follow
https://github.com/persnally/persnally/blob/main/docs/AGENT_INSTALL.md
exactly, then tell me what it learned about me and which of my AI clients
you connected.
```

Every command in that guide is non-interactive, so it runs unattended. It ends by
verifying the install with `persnally doctor` rather than assuming it worked.

Prefer each step explicit?

```bash
persnally start                      # the local daemon
persnally import claude ~/Downloads/<your-claude-export>
persnally import claude-code         # your local Claude Code sessions
persnally import cursor              # your local Cursor chat history
persnally import codex               # your local Codex session transcripts
persnally import git ~/Projects      # offline, no API needed
persnally profile                    # synthesize who you are
persnally dashboard                  # see it, with evidence for every claim
```

## How it works

```
  Your AI clients (Claude, Cursor, agents…)   Importers (claude · claude-code · chatgpt · cursor · codex · git)
        │  MCP: context out, signals in                  │  your history → events
        ▼                                                ▼
  ┌──────────────────────── persnallyd (local daemon) ────────────────────────┐
  │  Append-only event log (SQLite) — the single source of truth              │
  │      → extractors (decay-weighted interests, assertions, skills)          │
  │      → derived views (always re-derivable, every claim cites its events)  │
  └───────────────────────────────┬───────────────────────────────────────────┘
              loopback only ·  dashboard · CLI · MCP server
```

- **Event-sourced.** Everything is an append-only event; the profile and interest graph are *derived views* you can rebuild or delete at will.
- **Provenance-complete.** Every claim in your profile links to the exact events behind it — the dashboard's "why does it think this?" is a real answer, not a guess.
- **Truly deletable.** `persnally forget <topic>` hard-deletes the events *and* everything derived from them. No tombstones, no residue.
- **Yours to take.** `persnally export` writes the whole store — events, profile, interests, voice — to a file you keep. No lock-in to prove.
- **Deterministic reads.** Serving context to an AI never calls a model — it's instant, free, and works offline. Models run only at import and synthesis.

## Make your AI tools use it

```bash
persnally connect --all     # writes the MCP config for every installed client
```

Or add the MCP server to any client manually. It exposes six tools backed by the daemon:

| Tool | What it does |
|------|-------------|
| `persnally_context` | Returns who you are + current interests, for the AI to use |
| `persnally_ask` | Answers a question *about you* with a confidence score, or defers to asking you directly |
| `persnally_search` | Looks up what Persnally knows on one subject (offline, no model call) |
| `persnally_track` | Records signals from the conversation (topics, decisions, preferences) |
| `persnally_interests` | Shows you your own tracked profile |
| `persnally_forget` | Deletes a topic, a writing pattern, or everything |

```jsonc
// e.g. Claude Desktop — claude_desktop_config.json
{ "mcpServers": { "persnally": { "command": "persnally-mcp" } } }
```

`connect` knows where each client keeps its config and what shape it expects — they agree on stdio and little else:

| Client | Config |
|---|---|
| Claude Code · Claude Desktop · Cursor | `mcpServers` |
| Codex CLI | `~/.codex/config.toml` — TOML, not JSON |
| Gemini CLI | `~/.gemini/settings.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |
| Zed | `~/.config/zed/settings.json` — `context_servers` |
| VS Code | user `mcp.json` — `servers`, with `"type": "stdio"` |

**ChatGPT is a special case.** Its connectors require a public HTTPS MCP endpoint — no localhost, no stdio — so a loopback daemon structurally cannot serve it. You can import your ChatGPT history today; live context arrives with the agent relay (Phase 4).

## Your data, your rules

- **On your machine.** State lives in `~/.persnally`. Extraction runs fully offline with Ollama, or through your own key — either way, nothing leaves your machine except the text you choose to send to the model you chose, at import and synthesis.
- **Structured signals only.** Raw conversations are never stored — only `{ topic, weight, intent, sentiment, category, … }` and provenance pointers.
- **Inspectable & deletable.** The dashboard shows everything; the delete button means it.
- **Source-available.** Read the engine, audit the claims, run it yourself. Licensed FSL-1.1-MIT: free to use, read and run; converts to MIT two years after each release.

## CLI

```
persnally setup [--yes] [--engine …]    # one command: import, synthesize, connect (--yes runs unattended)
persnally doctor [--json]               # check the install end to end; exit 1 if broken
persnally start | stop | status         # daemon lifecycle
persnally autostart [--remove]          # run at login (macOS)
persnally connect [client|--all]        # claude-code · claude-desktop · cursor · codex · gemini-cli · windsurf · zed · vscode
persnally import claude|claude-code|chatgpt|cursor|codex|git <path>
persnally scope <client> <categories>   # limit what a client can read
persnally profile                       # synthesize the profile
persnally consolidate                   # reflect now: refresh decay, add behavior patterns
persnally voice                         # refresh your "how you write" fingerprint (offline)
persnally show [topics|events|profile]
persnally dashboard                     # open the local dashboard (authenticated link)
persnally activity [--json]             # context-read engagement over time (retention pulse)
persnally export [--md] [--out <file>] # take everything with you (JSON, or a readable portrait)
persnally forget <topic> | --all | --batch <id> | --style <dim> <pattern>
persnally config set-key <sk-ant-…>     # key for the background daemon
```

## Status

Early and moving fast — see [ROADMAP.md](https://github.com/persnally/persnally/blob/main/ROADMAP.md). Today: import from Claude, ChatGPT, Claude Code, Cursor, Codex, and git; a decay-weighted interest graph; an evidence-linked profile; a voice & convention layer so connected tools answer the way you write; a local dashboard with full provenance and one-click deletion; per-client permission scoping; nightly consolidation; and the MCP layer that serves it all. Next: cross-tool context everywhere, then a behavior model that can answer *what would I do here?*

## License

[FSL-1.1-MIT](./LICENSE) — read it, audit it, run it, fork it for anything except reselling it as a competing service. Every release automatically becomes plain MIT two years after it ships. The [event schema](https://github.com/persnally/persnally/blob/main/docs/EVENT_SCHEMA.md) and [MCP interface](https://github.com/persnally/persnally/blob/main/docs/MCP_INTERFACE.md) are versioned open specs (CC-BY) — build against them freely.

## Contributing

Issues and PRs welcome. The codebase holds itself to a high bar — see [CONTRIBUTING.md](https://github.com/persnally/persnally/blob/main/CONTRIBUTING.md).
