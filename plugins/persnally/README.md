# Persnally for Claude Code

Persnally builds a model of you from your own AI history, on your machine, and every AI you
use reads it. This plugin makes Claude Code one of them:

- **SessionStart hook** — injects your context (who you are, current interests, conventions,
  voice) at the start of every session. A local read; no model call, no network.
- **`/persnally:setup`** — installs and verifies Persnally non-interactively when it isn't there,
  and connects Claude Code's MCP tools.

The MCP tools (`persnally_context`, `persnally_ask`, `persnally_search`, `persnally_track`,
`persnally_interests`, `persnally_forget`) are deliberately **not** in this plugin. Every client
that talks to the daemon presents its own identity token from its own config, so the daemon can
tell clients apart and honour per-client scopes and revocation. A shared plugin manifest cannot
carry a per-install secret, so the server is registered by `persnally connect claude-code`
(which `setup` runs), with the token in your user config. `persnally_ask` is the tool to know:
the agent asks your model instead of interrupting you, and gets an answer with a confidence
score or a deferral.

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

`persnally connect claude-code` also used to write this SessionStart hook into
`~/.claude/settings.json`. Since 3.2, `connect` detects an installed, enabled Persnally plugin
and skips its own hook, so a fresh setup never gets two. If you connected before installing the
plugin, remove the Persnally entry under `hooks.SessionStart` in `~/.claude/settings.json` once
— `connect` never deletes hooks it didn't just write.

## What it knows, and how to make it forget

Everything lives in one SQLite file, `~/.persnally/persnally.db`. `persnally dashboard` shows
every claim with the events behind it. `persnally forget <topic>` hard-deletes a claim and
everything derived from it. `persnally export` takes it all with you. Source-available under
FSL-1.1-MIT.
