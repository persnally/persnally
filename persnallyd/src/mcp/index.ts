#!/usr/bin/env node

/**
 * Persnally MCP server — the protocol adapter between AI clients and persnallyd.
 *
 * The daemon owns all state (invariant: one write path, one source of truth);
 * this server translates MCP tool calls into daemon HTTP calls. Claude IS the
 * NLP engine: it fills persnally_track's structured schema from conversation
 * context, so signal extraction costs zero extra inference.
 */

import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DAEMON_HINT, DaemonUnreachable, daemonDelete, daemonGet, daemonPost } from "./daemon-client.js";
import { migrateV1Graph } from "./migrate-v1.js";
import { getClient, logEvent, setClient } from "./telemetry.js";

// Handshake version tracks package.json — same rule as the daemon's VERSION.
const pkg = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf-8")) as { version: string };
const server = new McpServer({ name: "persnally", version: pkg.version });

interface TopicRow {
  topic: string;
  category: string;
  weight: number;
  signals: number;
  dominant_intent: string;
  sentiment_balance: number;
  entities: string[];
}

interface Profile {
  headline: string;
  sections: { title: string; body: string }[];
  generated_at: string;
}

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

async function guarded(fn: () => Promise<{ content: { type: "text"; text: string }[] }>) {
  try {
    return await fn();
  } catch (e) {
    return text(e instanceof DaemonUnreachable ? DAEMON_HINT : `Persnally error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Event sources must match ^mcp:[a-z0-9._-]+$ — slugify whatever name the client reports. */
function clientSlug(): string {
  return getClient().toLowerCase().replace(/[^a-z0-9._-]/g, "-");
}

/** The north-star metric (context reads/user/week) is measured from these events.
    Recording must never break the read itself — failures only log to stderr. */
async function recordRead(scope: string, purpose: string | undefined, items: number): Promise<void> {
  const client = clientSlug();
  try {
    await daemonPost("/events", [{
      type: "context.read",
      source: `mcp:${client}`,
      payload: { scope, client_purpose: purpose ?? "", items },
      provenance: { kind: "mcp", client },
    }]);
  } catch (e) {
    console.error("persnally: context.read not recorded:", e instanceof Error ? e.message : e);
  }
}

// ── persnally_track — write path ────────────────────────────

const TOPIC_SCHEMA = z.object({
  topic: z.string().describe("The topic, decision, or preference (e.g. 'Rust async programming', 'chose SQLite over Postgres')"),
  weight: z.number().min(0).max(1),
  intent: z.enum(["learning", "building", "researching", "deciding", "discussing", "debugging"]),
  sentiment: z.enum(["positive", "negative", "neutral"]),
  depth: z.enum(["mention", "moderate", "deep"]),
  category: z.enum(["technology", "business", "finance", "career", "health", "science", "creative", "education", "lifestyle", "news", "other"]),
  entities: z.array(z.string()),
});
const STYLE_SCHEMA = z.object({
  dimension: z.enum(["voice", "convention", "emphasis", "format", "workflow"])
    .describe("voice=tone/phrasing; convention=tools/rules; emphasis=what they insist on; format=structure; workflow=how they work"),
  pattern: z.string().min(1).describe("a short, reusable instruction — e.g. 'prefers pnpm over npm', 'wants the falsification first', 'terse, no filler'"),
  polarity: z.enum(["does", "avoids", "prefers", "insists"]),
  confidence: z.number().min(0).max(1).default(0.6),
  evidence: z.string().default("").describe("a brief quote or why you believe it"),
});
const CORRECTION_SCHEMA = z.object({
  subject: z.string().default("").describe("what the correction is about, if nameable (e.g. 'npm', 'my role')"),
  correction: z.string().min(1).describe("the corrected truth, as the user stated it — e.g. 'uses pnpm, not npm', 'is a founder, not a contractor'"),
});

server.tool(
  "persnally_track",
  `Track what builds the user's lasting context. Three kinds of signal, all optional — send whichever this conversation produced.

TOPICS — what they're engaged with (interests, decisions, accepted/rejected options).
- 1-5 per conversation; weight = centrality (0.1 brief … 1.0 main focus); depth = mention|moderate|deep; sentiment 'negative' deprioritizes; entities are specific names ("Next.js", not "web framework").

STYLE — HOW they write and work, so every AI can answer like them. High value, but easy to over-send: record only a CLEAR, REPEATED tell, never a one-off, at most 1-3 per conversation. Examples:
- voice: "terse, no filler" · convention: "prefers pnpm over npm", "no default exports" · emphasis: "wants the falsification first" · format: "answers in bullet points" · workflow: "kills ideas fast".
- Skip anything generic or already obvious. When unsure, don't.

CORRECTIONS — when the user corrects something you (or their Persnally context) believed about them ("no, I actually…", "that's wrong, I…"). Record it VERBATIM in spirit — corrections become authoritative and outrank everything the model inferred. Send immediately when it happens, not at session end.

The user opted in. Only these structured signals are stored, locally, never raw messages.`,
  {
    topics: z.array(TOPIC_SCHEMA).optional(),
    style: z.array(STYLE_SCHEMA).optional(),
    corrections: z.array(CORRECTION_SCHEMA).optional(),
  },
  async ({ topics, style, corrections }) =>
    guarded(async () => {
      logEvent("tool_call", { tool: "persnally_track", topics: topics?.length ?? 0, style: style?.length ?? 0, corrections: corrections?.length ?? 0 });
      const client = clientSlug();
      const events = [
        ...(topics ?? []).map((t) => ({ type: "signal.topic", source: `mcp:${client}`, payload: t, provenance: { kind: "mcp", client } })),
        ...(style ?? []).map((s) => ({ type: "signal.style", source: `mcp:${client}`, payload: { ...s, basis: "observed" }, provenance: { kind: "mcp", client } })),
        ...(corrections ?? []).map((c) => ({ type: "user.correction", source: `mcp:${client}`, payload: { target_id: c.subject, action: "contradict", reason: c.correction }, provenance: { kind: "mcp", client } })),
      ];
      if (!events.length) return text("Nothing to track — pass topics, style, and/or corrections.");
      await daemonPost("/events", events);
      const parts: string[] = [];
      if (topics?.length) parts.push(`${topics.length} topic(s): ${topics.map((t) => t.topic).join(", ")}`);
      if (style?.length) parts.push(`${style.length} style signal(s)`);
      if (corrections?.length) parts.push(`${corrections.length} correction(s) — now authoritative`);
      return text(`Recorded ${parts.join(" · ")}.`);
    }),
);

// ── persnally_context — read path (the Phase 2 core) ────────

server.tool(
  "persnally_context",
  `Get the user's personal context: who they are, what they're working on, and their current interests.

Call this at the START of a conversation (or when personalization would improve your answer) so your responses fit this specific user instead of a generic one.`,
  {
    detail: z.enum(["brief", "full"]).optional().default("brief"),
    purpose: z.string().max(200).optional().describe("Why context is being read right now, in a short phrase (e.g. 'tailor architecture advice')"),
  },
  async ({ detail, purpose }) =>
    guarded(async () => {
      logEvent("tool_call", { tool: "persnally_context", detail });
      const client = encodeURIComponent(getClient());
      const [profile, topics, voice, skills] = await Promise.all([
        daemonGet<Profile>(`/profile?client=${client}`),
        daemonGet<TopicRow[]>(`/topics?limit=${detail === "full" ? 25 : 10}&client=${client}`),
        daemonGet<{ pack: string; items: unknown[] }>("/voice"),
        daemonGet<{ skill: string; domain: string; proficiency: number; sources: number }[]>("/skills?limit=15"),
      ]);
      if (!profile && !topics?.length && !voice?.pack) {
        return text("No context yet — the user hasn't imported data or tracked any signals.");
      }
      let out = "";
      let items = topics?.length ?? 0;
      if (profile) {
        out += `# About this user\n${profile.headline}\n\n`;
        const sections = detail === "full" ? profile.sections : profile.sections.slice(0, 3);
        items += sections.length;
        out += sections.map((s) => `## ${s.title}\n${s.body}`).join("\n\n");
      }
      // The prescriptive layer: how to write/answer so it fits this user, not a generic one.
      if (voice?.pack) {
        out += `${out ? "\n\n" : ""}# How to write for this user\n${voice.pack}`;
        items += voice.items?.length ?? 0;
      }
      // Demonstrated skills, from repos they actually commit to — evidence of
      // what they can do, distinct from what they've been talking about.
      if (skills?.length) {
        out += `${out ? "\n\n" : ""}# Demonstrated skills (from their own repos)\n`;
        out += skills.map((k) => `- ${k.skill}${k.domain && k.domain !== "other" ? ` (${k.domain})` : ""}`).join("\n");
        items += skills.length;
      }
      if (topics?.length) {
        out += `\n\n# Current interests (decay-weighted)\n`;
        out += topics.map((t) => `- ${t.topic} (${t.category}, ${t.dominant_intent}, weight ${t.weight.toFixed(2)})`).join("\n");
      }
      await recordRead(detail, purpose, items);
      return text(out);
    }),
);

// ── persnally_search — targeted context lookup ──────────────

interface SearchHit {
  kind: "topic" | "assertion";
  text: string;
  detail: string;
}

server.tool(
  "persnally_search",
  `Look up what Persnally knows about a SPECIFIC topic, tool, or subject — the user's stance, experience, and observed patterns around it. Use mid-conversation when a subject comes up and their history with it would sharpen your answer (e.g. before recommending a stack, check "rust" or "postgres").

Complements persnally_context (the broad profile): search is narrow and targeted. Returns nothing if the subject has never appeared in their history.`,
  {
    query: z.string().min(1).max(200).describe("The subject to look up — a topic, technology, project, or theme (e.g. 'rust', 'fundraising', 'testing practices')"),
  },
  async ({ query }) =>
    guarded(async () => {
      logEvent("tool_call", { tool: "persnally_search" });
      const client = encodeURIComponent(getClient());
      const hits = await daemonGet<SearchHit[]>(`/search?q=${encodeURIComponent(query)}&client=${client}`) ?? [];
      if (!hits.length) return text(`Persnally has nothing on "${query}" — the user's history doesn't cover it.`);
      await recordRead("search", `looked up: ${query}`, hits.length);
      const lines = hits.map((h) => `- [${h.kind === "topic" ? "interest" : "observed"}] ${h.text} (${h.detail})`);
      return text(`What Persnally knows about "${query}":\n${lines.join("\n")}`);
    }),
);

// ── persnally_ask — the decision loop (Phase 3) ─────────────

interface AskResult {
  answer: string;
  confidence: number;
  deferred: boolean;
  evidence_event_ids: string[];
}

server.tool(
  "persnally_ask",
  `Ask the user's personal model a question INSTEAD of interrupting the user. Use when you'd otherwise stop to ask about their preferences, conventions, taste, or how they'd decide — e.g. "would they want tests with this change?", "what tone should this email take?", "would they prefer a new dependency or hand-rolling it?".

Persnally answers from the user's accumulated history with a confidence score. If it can't answer confidently, it tells you to ask the user — then ask them directly. Never treat a deferred response as an answer.`,
  {
    question: z.string().min(1).max(500)
      .describe("A specific question about this user's preferences, conventions, or likely decision — not a general knowledge question"),
  },
  async ({ question }) =>
    guarded(async () => {
      logEvent("tool_call", { tool: "persnally_ask" });
      const r = await daemonPost<AskResult>("/ask", { question, client: getClient(), asker: getClient() });
      if (r.deferred) return text(r.answer);
      return text(
        `${r.answer}\n\n(confidence ${r.confidence.toFixed(2)} · ${r.evidence_event_ids.length} evidence event(s) · answered by the user's Persnally model — the user can audit this at http://127.0.0.1:4983)`,
      );
    }),
);

// ── persnally_interests — transparency view ─────────────────

server.tool(
  "persnally_interests",
  `Show the user their own tracked interest profile — what Persnally has learned. Use when the user asks what Persnally knows about them.`,
  {},
  async () =>
    guarded(async () => {
      logEvent("tool_call", { tool: "persnally_interests" });
      const [stats, topics] = await Promise.all([
        daemonGet<{ total: number; first: string | null; last: string | null }>("/stats"),
        daemonGet<TopicRow[]>("/topics?limit=20"),
      ]);
      if (!topics?.length) return text("Nothing tracked yet. Chat naturally, or import your AI history with `persnallyd import`.");
      let out = `## Your interest profile\n${stats?.total ?? 0} events, ${topics.length} top topics. Dashboard: http://127.0.0.1:4983\n\n`;
      for (const t of topics) {
        const sentiment = t.sentiment_balance > 0.2 ? "+" : t.sentiment_balance < -0.2 ? "−" : "·";
        out += `- ${t.topic} — ${t.weight.toFixed(2)} (${t.category}, ${t.dominant_intent}, ${sentiment}, ${t.signals}×)\n`;
      }
      return text(out);
    }),
);

// ── persnally_forget — privacy control ──────────────────────

server.tool(
  "persnally_forget",
  `Hard-delete a topic or a voice/style pattern (and everything derived from it) from the user's context. Privacy control — always honor it. A forgotten style pattern stays gone permanently, even if later conversations would otherwise re-observe it. Wiping everything is the user's own action: point them at the dashboard or \`persnallyd forget --all\`.`,
  {
    topic: z.string().optional().describe("Topic to remove."),
    style: z.object({
      dimension: z.enum(["voice", "convention", "emphasis", "format", "workflow"]),
      pattern: z.string(),
    }).optional().describe("A 'How you write' pattern to remove, e.g. {dimension: 'emphasis', pattern: 'be 100% sure'}."),
  },
  async ({ topic, style }) =>
    guarded(async () => {
      logEvent("tool_call", { tool: "persnally_forget" });
      if (style) {
        const r = await daemonDelete<{ deleted: number }>(`/voice/${encodeURIComponent(style.dimension)}/${encodeURIComponent(style.pattern)}`);
        return text(r.deleted ? `Forgot "${style.pattern}" — it won't be re-learned.` : `"${style.pattern}" not found.`);
      }
      if (!topic) return text("Name a topic or a style pattern to forget.");
      const r = await daemonDelete<{ deleted: number }>(`/topics/${encodeURIComponent(topic)}`);
      return text(r.deleted ? `Deleted ${r.deleted} event(s) for "${topic}", including derived data.` : `"${topic}" not found.`);
    }),
);

// ── start ───────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  server.server.oninitialized = () => {
    setClient(server.server.getClientVersion()?.name);
    logEvent("session_start");
    migrateV1Graph()
      .then((n) => { if (n > 0) logEvent("v1_migration", { nodes: n }); })
      .catch(() => { /* daemon down — migration retries on next session */ });
  };
  await server.connect(transport);
  console.error("Persnally MCP server v2 running (daemon-backed)");
}

main().catch(console.error);
