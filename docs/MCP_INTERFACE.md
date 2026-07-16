# Persnally MCP Interface — Open Contract

**Spec version: 1.0** · Status: **Stable** · License: open specification (CC-BY-4.0) — anyone may
implement a compatible client or a compatible server, no permission needed.

> The interface between AI clients (Claude, Cursor, agents) and a personal context engine, over
> [MCP](https://modelcontextprotocol.io) (stdio transport). Persnally's server is a thin adapter:
> all state lives behind a local daemon; the tools below are the whole contract a client sees.
> Normative reference implementation: [`persnallyd/src/mcp/index.ts`](../persnallyd/src/mcp/index.ts).
> Historical note: early drafts called the read/write pair `get_context`/`record_event`; the shipped
> names below are the contract.

**Stability policy.** Within 1.x: existing tools, parameters, and semantics don't change; new
*optional* parameters and new *tools* may be added. Removing/renaming a tool or changing its
semantics requires 2.0. The server reports its version in the MCP handshake (`serverInfo.version`
tracks the package version, not this spec's).

**Conformance.** A *server* is conformant if it exposes these six tools with these schemas and
semantics (§Tools), enforces scoping server-side (§Scoping), and records reads (§Metrics). A
*client* needs no Persnally-specific code — any MCP client that can call tools is conformant;
the SessionStart injection (§Default path) is optional but recommended.

---

## Tools

All results are MCP `text` content. Errors never throw protocol errors: failures return
human-readable text (e.g. the daemon-unreachable hint), so a broken engine degrades to "no
context" rather than breaking the client session.

### 1. `persnally_context` — the read path
Returns the user's personal context for injection: profile headline + sections, a
"How to write for this user" voice pack, and decay-weighted current interests.

| Param | Type | Semantics |
|---|---|---|
| `detail` | `"brief"` \| `"full"` (default `brief`) | brief = top 3 profile sections + 10 interests; full = all sections + 25 interests |
| `purpose` | string ≤200, optional | why context is being read — recorded, shown to the user in their read log |

Semantics: scoped clients receive their scope's own profile and only allowed-category interests
(§Scoping). An empty store returns an explanatory line, not an error. Every successful read is
recorded (§Metrics).

### 2. `persnally_track` — the write path
The client is the NLP engine: it fills structured signals from conversation context (zero extra
inference). Three optional arrays; send whichever the conversation produced.

| Param | Shape (per item) |
|---|---|
| `topics[]` | `{topic, weight 0–1, intent, sentiment, depth, category, entities[]}` — 1–5 per conversation |
| `style[]` | `{dimension, pattern, polarity, confidence?, evidence?}` — only clear, repeated tells; stored with `basis:"observed"` |
| `corrections[]` | `{subject?, correction}` — when the user corrects something believed about them; stored as authoritative `user.correction` (`action:"contradict"`) |

Payload shapes and enums are exactly the event-schema shapes ([EVENT_SCHEMA.md](./EVENT_SCHEMA.md));
the server stamps `source: mcp:<client>` and provenance from the MCP handshake client name.

### 3. `persnally_ask` — the decision loop
The client asks a question *about the user* instead of interrupting them.

| Param | Type |
|---|---|
| `question` | string 1–500 — about the user's preferences/conventions/likely decision |

Semantics: the engine answers from its evidence with a confidence score, or **defers** — the
response tells the client to ask the human, and a deferred response must never be treated as an
answer. Every exchange is persisted as `agent.question`/`agent.answer` events so answer precision
is user-auditable. Servers should rate-limit this tool (it may spend inference).

### 4. `persnally_search` — targeted lookup
What the engine knows about one specific subject ("rust", "testing practices"). Deterministic,
no inference. Returns matched interests and observations, or an explicit "nothing on X".
Hits are recorded as reads with the query as purpose; misses are not (§Metrics).

| Param | Type |
|---|---|
| `query` | string 1–200 — a topic/technology/theme, not a general-knowledge question |

### 5. `persnally_interests` — transparency view
No parameters. Shows the user their own tracked interest profile (top topics with weights,
store stats, dashboard link). For "what does Persnally know about me?" moments.

### 6. `persnally_forget` — the privacy control
Always honored. One of:

| Param | Effect |
|---|---|
| `topic` | hard-delete the topic and everything derived from it |
| `style {dimension, pattern}` | delete + permanently tombstone a voice pattern (never re-learned) |
| `clear_all: true` | delete all data |

---

## Scoping (server-side, non-bypassable)

The user may restrict a client to category allowlists (e.g. Cursor → `technology,career`).
Enforcement is in the daemon, not the MCP adapter: a scoped client gets only allowed-category
interests and its scope's own synthesized profile — never the cross-category narrative,
assertions, corrections, or other categories' topics. An empty allowlist = revoked (reads
nothing). Client identity comes from the MCP handshake (`clientInfo.name`, slugified to
`[a-z0-9._-]`); it is self-reported, so scoping is honest-client enforcement until per-client
tokens exist.

## Default path (recommended)

Clients with a session-start hook mechanism should inject `persnally_context` output at session
start and instruct the session to (a) call `persnally_ask` before interrupting the user with
preference questions and (b) call `persnally_track` once at session end. Measured compliance
with soft instructions is low; injection at session start is the reliable half.

## Metrics

Servers record every served read as a `context.read` event `{scope, client_purpose, items}` —
the substrate for the user-facing read log ("what your AIs read about you") and engagement
metrics. Recording failures must never break the read itself. Empty serves are not recorded.
