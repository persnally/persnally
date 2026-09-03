# Persnally for Claude Code

Persnally builds a model of you from your own AI history, on your machine, and every AI you
use reads it. This plugin makes Claude Code one of them:

- **SessionStart hook** — injects your context (who you are, current interests, conventions,
  voice) at the start of every session. A local read; no model call, no network.
- **MCP server** — `persnally_context`, `persnally_ask`, `persnally_search`, `persnally_track`,
  `persnally_interests`, `persnally_forget`. `persnally_ask` is the one to know: the agent asks
  your model instead of interrupting you, and gets an answer with a confidence score or a deferral.
- **`/persnally:setup`** — installs and verifies Persnally non-interactively when it isn't there.

## Install

```
/plugin marketplace add persnally/persnally
/plugin install persnally@persnally
```

The plugin expects the `persnally` CLI on your PATH (`npm i -g persnally`). If it isn't
installed yet, run `/persnally:setup` once; the hook stays silent until then rather than failing
your session.

Extraction runs fully offline with Ollama, or bring your own Anthropic key. Serving context to
Claude Code never calls a model.

## Already connected the old way?

`persnally connect claude-code` writes the same hook and MCP server into your user settings. With
both, you get the context injected twice and duplicate tools. Keep one: either uninstall this
plugin, or remove the Persnally entries from `~/.claude/settings.json` and `~/.claude.json`.
A future `persnally connect` detects the plugin and skips itself.

## What it knows, and how to make it forget

Everything lives in one SQLite file, `~/.persnally/persnally.db`. `persnally dashboard` shows
every claim with the events behind it. `persnally forget <topic>` hard-deletes a claim and
everything derived from it. `persnally export` takes it all with you. Source-available under
FSL-1.1-MIT.
