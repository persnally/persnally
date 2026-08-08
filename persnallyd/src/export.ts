/**
 * Takeout. "Persnally makes it yours" is only true if you can leave with it —
 * ownership without portability is lock-in with better branding.
 *
 * JSON is the complete, re-importable record: the event log is the source of
 * truth and everything else in the bundle re-derives from it. Markdown is the
 * human-readable portrait, for reading and sharing rather than restoring.
 *
 * Credentials live in config, never in the store, so no key, token, or session
 * can reach a bundle — asserted in the tests rather than left to trust.
 */

import type { PersnallyEvent } from "./events.js";
import type { EventStore, StoredProfile, TopicRow } from "./store.js";
import type { StyleSignal } from "./stylometry.js";

export const EXPORT_FORMAT_VERSION = 1;

export interface ExportBundle {
  format_version: number;
  exported_at: string;
  generator: string;
  counts: { events: number; topics: number; style: number; corrections: number };
  profile: StoredProfile | null;
  topics: TopicRow[];
  voice: { pack: string; items: StyleSignal[] };
  corrections: { id: string; ts: string; subject: string; correction: string }[];
  events: PersnallyEvent[];
}

export function buildBundle(store: EventStore, version: string, now = new Date()): ExportBundle {
  // limit -1 is SQLite's "no limit": the whole log, since a partial export
  // would be a worse promise than none.
  const events = store.query({ limit: -1 });
  const topics = store.topics(Number.MAX_SAFE_INTEGER);
  const voice = store.voice();
  const corrections = store.corrections(Number.MAX_SAFE_INTEGER);
  return {
    format_version: EXPORT_FORMAT_VERSION,
    exported_at: now.toISOString(),
    generator: `persnally ${version}`,
    counts: {
      events: events.length,
      topics: topics.length,
      style: voice.items.length,
      corrections: corrections.length,
    },
    profile: store.getProfile(),
    topics,
    voice,
    corrections,
    events,
  };
}

export function renderMarkdown(b: ExportBundle): string {
  const out: string[] = [];
  const date = b.exported_at.slice(0, 10);

  out.push(`# Your Persnally context`, "", `_Exported ${date} by ${b.generator}. ${b.counts.events} events._`, "");

  if (b.profile) {
    out.push(`## ${b.profile.headline}`, "");
    for (const s of b.profile.sections) out.push(`### ${s.title}`, "", s.body, "");
    out.push(`_Synthesized ${b.profile.generated_at.slice(0, 10)} with ${b.profile.model}._`, "");
  } else {
    out.push("_No profile synthesized yet — run `persnallyd profile`._", "");
  }

  if (b.voice.pack) out.push("## How you write", "", b.voice.pack, "");

  if (b.topics.length) {
    out.push("## Interests", "", "| Topic | Category | Weight | Signals |", "|---|---|---:|---:|");
    for (const t of b.topics.slice(0, 100)) {
      out.push(`| ${esc(t.topic)} | ${t.category} | ${t.weight.toFixed(2)} | ${t.signals} |`);
    }
    if (b.topics.length > 100) out.push("", `_… and ${b.topics.length - 100} more; the JSON export has all of them._`);
    out.push("");
  }

  if (b.corrections.length) {
    out.push("## What you corrected", "");
    for (const c of b.corrections) {
      out.push(`- ${esc(c.correction)}${c.subject ? ` _(about ${esc(c.subject)})_` : ""}`);
    }
    out.push("");
  }

  return out.join("\n");
}

/**
 * Table cells break on a bare pipe; newlines break the row. Backslash goes
 * first — escaping the pipe alone leaves `\|` as `\\|`, which Markdown reads as
 * an escaped backslash followed by a live cell separator, so the value escapes
 * its cell. Topic names are client-writable via persnally_track.
 */
function esc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");
}
