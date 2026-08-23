/**
 * The one place context is rendered for a model, and the one place a read is
 * recorded.
 *
 * There used to be two renderers — the CLI hook and the MCP tool — and they
 * drifted: the hook served interests and per-project conventions but no writing
 * style, the tool served style and skills but no conventions, and they even
 * disagreed on the heading. So Claude Code never learned how to write for the
 * user and Cursor never learned their conventions, purely from duplication.
 *
 * Recording was duplicated the same way, once per channel, each inventing its
 * own `source` — which is how a hook read came to be attributed to the owner
 * instead of the client it was injected into (#129).
 *
 * Both live here now, and `test/context-one-door.test.ts` fails if a second
 * renderer or a second writer appears. A new delivery channel gets correct
 * content and correct attribution by construction, or it does not compile.
 */

import { newEvent } from "./events.js";
import { projectLabel } from "./importers/claude-code.js";
import { type Category, readsNothing } from "./permissions.js";
import { statedConvention } from "./stylometry.js";
import { scopeKey } from "./profile.js";
import type { EventStore } from "./store.js";

export interface PackOptions {
  /** `full` widens the profile and the interest list; `brief` is the default. */
  detail?: "brief" | "full";
  /** Workspace being served into, when the caller knows it. Scopes conventions. */
  project?: string;
  /** Categories the reader may see. null = unrestricted (the owner). */
  allowed?: Category[] | null;
}

export interface ContextPack {
  text: string;
  /** What was actually served — the number the read receipt reports. */
  items: number;
}

/** How the context reached the reader. Determines the recorded `source`. */
export type ReadSurface = "mcp" | "hook" | "cli" | "dashboard";

export function buildContextPack(store: EventStore, opts: PackOptions = {}): ContextPack {
  const full = opts.detail === "full";
  const allowed = opts.allowed ?? null;
  if (readsNothing(allowed)) return { text: "", items: 0 };
  const out: string[] = [];
  let items = 0;

  // A scoped reader gets its scope's own synthesized narrative, never the
  // holistic one — same boundary the /profile route enforces.
  const profile = allowed ? store.getScopedProfile(scopeKey(allowed)) : store.getProfile();
  if (profile) {
    out.push("# About the user", profile.headline, "");
    const sections = full ? profile.sections : profile.sections.slice(0, 3);
    items += sections.length;
    for (const s of sections) out.push(`## ${s.title}`, s.body, "");
  }

  let topics = store.topics(full ? 25 : 12);
  if (allowed) topics = topics.filter((t) => allowed.includes(t.category as Category));
  if (topics.length) {
    out.push("# Current interests (decay-weighted)");
    for (const t of topics) {
      out.push(`- ${t.topic} (${t.category}, ${t.dominant_intent}, weight ${t.weight.toFixed(2)})`);
    }
    out.push("");
    items += topics.length;
  }

  // The prescriptive layer: how to write for them, and how they work here. A
  // convention carrying a project is served only when serving into it.
  const voice = store.voice(opts.project);
  if (voice.pack) {
    out.push("# How to write for this user", voice.pack, "");
    items += voice.items.length;
  }
  const local = voice.items.filter((i) => i.dimension === "convention" || i.dimension === "workflow");
  if (local.length) {
    const label = opts.project ? projectLabel(opts.project) : "";
    out.push(`# How they work${label ? ` in ${label}` : ""}` + " (observed behaviour — outranks the general claims above)");
    for (const s of local.slice(0, 8)) out.push(`- ${statedConvention(s)}`);
    out.push("");
  }

  // Evidence of what they can do, from repos they commit to — distinct from
  // what they have been talking about.
  const skills = store.skills(15);
  if (skills.length) {
    out.push("# Demonstrated skills (from their own repos)");
    for (const k of skills) {
      out.push(`- ${k.skill}${k.domain && k.domain !== "other" ? ` (${k.domain})` : ""}`);
    }
    out.push("");
    items += skills.length;
  }

  return { text: out.join("\n").trimEnd(), items };
}

/**
 * The only writer of `context.read`. Attribution is derived here rather than at
 * each call site: a read over MCP and a read injected by a client's hook are
 * both that client consuming context, and only the mechanism differs.
 */
export function recordContextRead(
  store: EventStore,
  opts: { surface: ReadSurface; client?: string; scope: string; purpose: string; items: number },
): void {
  const client = (opts.client ?? "").toLowerCase().replace(/[^a-z0-9._-]/g, "-");
  const source = opts.surface === "mcp" || opts.surface === "hook"
    ? `${opts.surface}:${client || "unknown"}`
    : opts.surface;
  const provenance = opts.surface === "mcp"
    ? { kind: "mcp" as const, client: client || "unknown" }
    : { kind: "local" as const, surface: opts.surface, ...(client ? { client } : {}) };
  // Recording must never break the read itself.
  try {
    store.append([newEvent("context.read", source, {
      scope: opts.scope, client_purpose: opts.purpose, items: opts.items,
    }, provenance)]);
  } catch (e) {
    console.error("persnally: context.read not recorded:", e instanceof Error ? e.message : e);
  }
}
