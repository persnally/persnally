# Persnally

**So every AI finally knows you.**

Persnally is a local-first personal context engine. It learns who you are from your AI activity — your Claude and ChatGPT history, your code — and serves that context to every AI tool you use, so they stop treating you like a stranger.

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

One command builds your mirror: it finds Claude/ChatGPT exports in `~/Downloads`, reads your local Claude Code sessions and git repos, synthesizes an evidence-linked profile, connects your AI clients (Claude Desktop, Claude Code, Cursor), and opens the dashboard.

For the richest result, export your data first ([claude.ai](https://claude.com) / [chatgpt.com](https://chatgpt.com) → Settings → Data export) and drop it in `~/Downloads` — then read a description of yourself that's sharper than your own bio, every sentence traceable to the conversations it came from.

Prefer each step explicit?

```bash
persnallyd start                      # the local daemon
persnallyd import claude ~/Downloads/<your-claude-export>
persnallyd import claude-code         # your local Claude Code sessions
persnallyd import git ~/Projects      # offline, no API needed
persnallyd profile                    # synthesize who you are
open http://127.0.0.1:4983            # see it, with evidence for every claim
```

## How it works

```
  Your AI clients (Claude, Cursor, agents…)   Importers (claude · claude-code · chatgpt · git)
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
- **Truly deletable.** `persnallyd forget <topic>` hard-deletes the events *and* everything derived from them. No tombstones, no residue.
- **Deterministic reads.** Serving context to an AI never calls a model — it's instant, free, and works offline. Models run only at import and synthesis.

## Make your AI tools use it

```bash
persnallyd connect --all     # writes the MCP config for Claude Desktop, Claude Code, Cursor
```

Or add the MCP server to any client manually. It exposes four tools backed by the daemon:

| Tool | What it does |
|------|-------------|
| `persnally_context` | Returns who you are + current interests, for the AI to use |
| `persnally_track` | Records signals from the conversation (topics, decisions, preferences) |
| `persnally_interests` | Shows you your own tracked profile |
| `persnally_forget` | Deletes a topic, or wipes everything |

```jsonc
// e.g. Claude Desktop — claude_desktop_config.json
{ "mcpServers": { "persnally": { "command": "persnally-mcp" } } }
```

## Your data, your rules

- **Local-first.** State lives in `~/.persnally`. Nothing leaves your machine except, at import/synthesis, the text you choose to send to your own LLM for extraction (bring your own key).
- **Structured signals only.** Raw conversations are never stored — only `{ topic, weight, intent, sentiment, category, … }` and provenance pointers.
- **Inspectable & deletable.** The dashboard shows everything; the delete button means it.
- **Source-available.** Read the engine, audit the claims, run it yourself.

## CLI

```
persnally setup                          # one command: import, synthesize, connect
persnallyd start | stop | status         # daemon lifecycle
persnallyd autostart [--remove]          # run at login (macOS)
persnallyd connect [client|--all]        # add to claude-code | claude-desktop | cursor
persnallyd import claude|claude-code|chatgpt|git <path>
persnallyd scope <client> <categories>   # limit what a client can read
persnallyd profile                       # synthesize the profile
persnallyd consolidate                   # reflect now: refresh decay, add behavior patterns
persnallyd voice                         # refresh your "how you write" fingerprint (offline)
persnallyd show [topics|events|profile]
persnallyd activity                      # context-read engagement over time (retention pulse)
persnallyd forget <topic> | --all | --batch <id> | --style <dim> <pattern>
persnallyd config set-key <sk-ant-…>     # key for the background daemon
```

## Status

Early and moving fast — see [ROADMAP.md](./ROADMAP.md). Today: import from Claude, ChatGPT, Claude Code, and git; a decay-weighted interest graph; an evidence-linked profile; a voice & convention layer so connected tools answer the way you write; a local dashboard with full provenance and one-click deletion; per-client permission scoping; nightly consolidation; and the MCP layer that serves it all. Next: cross-tool context everywhere, then a behavior model that can answer *what would I do here?*

## License

[FSL-1.1-MIT](./LICENSE) — read it, audit it, run it, fork it for anything except reselling it as a competing service. Every release automatically becomes plain MIT two years after it ships. The [event schema](./docs/EVENT_SCHEMA.md) and [MCP interface](./docs/MCP_INTERFACE.md) are versioned open specs (CC-BY) — build against them freely.

## Contributing

Issues and PRs welcome. The codebase holds itself to a high bar — see [CONTRIBUTING.md](./CONTRIBUTING.md).
