# Roadmap

Persnally builds a model of you from your own AI history, on your machine, and every AI you use reads it. Today that is eight MCP clients (Claude Code, Claude Desktop, Cursor, Codex, Gemini CLI, Windsurf, Zed, VS Code); ChatGPT imports today and reads live once the agent relay ships, since its connectors cannot reach a loopback server. The roadmap is that one sentence with "every AI" meaning more each year: first the tools you type into, then the agents that act for you, then the agents that act for your team.

We build in rungs, and each rung has to earn the next.

## Now — The Mirror ✅

Install it, point it at your AI history, and see the model of you.

- Local daemon (`persnallyd`) with an append-only event store — your data, on your machine
- Importers: Claude and ChatGPT exports, Claude Code, Cursor and Codex sessions, git history
- Decay-weighted interest graph (recent interests outweigh stale ones)
- A synthesized portrait where every claim cites its evidence
- Local dashboard — inspect everything, see why it believes each thing, delete anything
- MCP server so any AI client can read the model — eight clients, one `persnally connect --all`

## Next — The Layer and the Loop

Every AI reads you at session start. Your agents ask you-the-model before they ask you.

- Per-client scopes — decide what each tool can see, and see what each tool has read
- `persnally_ask`: an agent asks "what would they want here?" and gets an answer with a confidence score, or a deferral back to you
- Every correction, approval and veto sharpens the model, automatically
- Nightly local consolidation: the engine reflects on the day's activity while you sleep
- A published benchmark: how often the model answers correctly, how often it rightly defers

## Later — The person layer

Any agent acting on your behalf consults the model of you first.

- A behavior model with a visible, measured fidelity score — earned, not claimed
- Agents that stop interrupting you: the same task, fewer questions, at a precision you can see
- Teams: how this team decides, builds and communicates — derived from opt-in individuals; the org sees views, never raw events

## Always

- **On your machine.** Custody of your data stays with you. Extraction runs fully offline with Ollama, or through your own key.
- **Cloud as amplifier, never custodian.** Optional paid services run on your behalf and never hold your data at rest in the clear: sync, backup and the agent relay carry ciphertext only; zero-setup inference sees the text you send it in transit, while it runs, and never stores it.
- **Source-available and inspectable.** Audit the engine; verify the claims. FSL-1.1-MIT, converting to MIT after two years.
- **Deletable for real.** Forgetting removes the data and everything derived from it.

---

Have a use case or a client you want supported? Open an issue.
