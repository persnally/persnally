---
description: Install or repair Persnally on this machine — the model of the user that this and every other AI client reads at session start. Use when the user asks to set up Persnally, when persnally_context is unavailable, or when the Persnally hook reports nothing.
disable-model-invocation: false
---

Persnally builds a model of the user from their own AI history, on their machine, and every
AI they use reads it. This skill gets it running here, non-interactively, and verifies it.

1. Check whether it is installed: run `command -v persnally && persnally --version`.
2. If it is not installed, run `npm i -g persnally`.
3. Run `persnally setup --yes`. This finds Claude/ChatGPT exports in `~/Downloads`, reads the
   local Claude Code, Cursor and Codex sessions and git repos, synthesizes the model, and
   connects the installed AI clients. It picks a local Ollama model when one is available, so
   it runs fully offline; otherwise it asks for an Anthropic key — stop and ask the user for it
   rather than guessing. Never paste a key into chat.
4. Run `persnally doctor`. Report exactly what it prints. Exit code 1 means something is
   broken; say what, do not claim success.
5. Tell the user, in two lines, what Persnally learned about them (`persnally show profile`,
   first section only) and that this client now reads it at every session start via the
   plugin hook. Remind them: `persnally forget <topic>` deletes a claim and everything derived
   from it; `persnally export` takes everything with them.

If the user already ran `persnally connect claude-code` before installing this plugin, the
hook and MCP server are registered twice. Run `persnally connect claude-code --remove` if that
flag exists in their version; otherwise tell them to remove the Persnally entries from
`~/.claude/settings.json` (`hooks.SessionStart`) and `~/.claude.json` (`mcpServers.persnally`)
so the plugin's copies are the only ones.
