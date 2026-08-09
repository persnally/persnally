# Installing Persnally (for an AI agent)

You are setting Persnally up on behalf of the user. Work through this top to
bottom. Every command is non-interactive and safe to run unattended.

Persnally is a local-first context engine: it reads the user's existing AI
history from their machine, builds a profile of them, and serves it to AI
clients over MCP. Nothing leaves the machine except text sent to the user's own
model during import, and only if they have configured one.

## 0. Preconditions

```bash
node --version      # must be >= 22
```

If Node is older than 22, stop and tell the user — do not attempt an upgrade
yourself; how Node is installed is their decision.

## 1. Install

```bash
npm install -g persnally
persnally --version
```

If `npm install -g` fails with `EACCES`, do **not** re-run it with `sudo`.
Report the error and suggest a Node version manager instead — a root-owned
global install causes exactly the permission problems this product diagnoses.

## 2. Choose an extraction engine

Conversation import needs a model. Three valid outcomes — pick the first that
applies and **do not ask the user to choose unless none apply**:

| Situation | Command |
|---|---|
| `ANTHROPIC_API_KEY` is set, or the user gives you a key | `persnally config set-key sk-ant-…` |
| Ollama is installed (`curl -s localhost:11434/api/tags` responds) | `persnally setup --yes` — fetches a ~2GB model if needed |
| Neither, and the user does not want either | `persnally setup --engine none` |

`--engine none` is a real option, not a failure: git history and writing-style
analysis are fully offline and still produce a useful profile. Conversation
import is simply deferred; re-running `persnally setup` later picks up exactly
what was skipped.

Never put an API key in a shell command you echo back to the user, and never
write one into a file other than via `persnally config set-key`.

## 3. Run setup

```bash
persnally setup --yes
```

This starts the daemon, imports what it finds (Claude/ChatGPT exports in
`~/Downloads`, Claude Code transcripts, git repos under `~/Projects`),
synthesizes a profile, connects installed AI clients, and prints a dashboard
URL. It is idempotent — re-running it does not duplicate data.

**Richer result:** if the user has not exported their Claude/ChatGPT history,
tell them it roughly doubles what Persnally can learn:
claude.ai or chatgpt.com → Settings → Data export → save the zip to
`~/Downloads` → re-run `persnally setup --yes`. Do not block on this.

## 4. Connect their AI clients

```bash
persnally connect --all
```

Configures every installed client: `claude-code`, `claude-desktop`, `cursor`,
`codex`, `gemini-cli`, `windsurf`, `zed`, `vscode`. Clients that are not
installed are skipped, not created. Tell the user to **restart any client that
was already running** — it reads its MCP config at launch.

**ChatGPT (chatgpt.com) cannot be connected.** Its connectors require a public
HTTPS MCP endpoint; Persnally is loopback-only by design. The user's ChatGPT
*history* still imports. Say this plainly if asked, rather than trying to make
it work.

## 5. Verify

```bash
persnally doctor
```

Exit code 0 = healthy or warnings only; 1 = something is broken. Each finding
prints a `→` line with the exact command that fixes it — run it, then re-run
`persnally doctor`.

`--json` gives machine-readable output if you would rather branch on fields
than parse text.

Then confirm there is actually something there:

```bash
persnally show
```

Empty output after a successful setup means no history was found — not a
failure of the install. Point the user at step 3's export instructions.

## Failure modes and what they mean

| Symptom | Cause | Action |
|---|---|---|
| `permission denied` running any command | install lost its executable bit | `persnally doctor` prints the exact `chmod` |
| `doctor` says daemon version ≠ CLI version | upgraded on disk, old process still running | `persnally restart` |
| `doctor` says capture stopped | hook missing or daemon was down | `persnally connect claude-code && persnally restart` |
| Setup reports sources "skipped" | no extraction engine | step 2, then re-run setup |
| Client shows no Persnally tools | client not restarted since connect | restart the client |

## Do not

- Run anything with `sudo`.
- Modify files under `~/.persnally` directly — it is an append-only event store
  with derived views; hand-editing corrupts provenance.
- Send the user's data anywhere. Import calls only the model the user
  configured; there is no Persnally cloud.
- Claim setup succeeded without running `persnally doctor`.

## Reporting back

Tell the user, briefly:
- what was imported (`persnally show` — top interests)
- which clients were connected, and that they need restarting
- the dashboard URL from setup, so they can see and delete anything
- anything `doctor` still flags
