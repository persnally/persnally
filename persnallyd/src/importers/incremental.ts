/**
 * Shared engine behind incremental import: given a source's parsed
 * conversations (with per-message watermark ids), diff each already-seen
 * conversation against its last recorded watermark and extract only new or
 * never-seen content — this is what makes the daemon's periodic pass cheap
 * instead of re-paying to re-extract a whole history on every tick.
 *
 * Originally claude-code.ts's own logic (the only source with per-message
 * watermarks for a long time). Generalized here once cursor.ts and codex.ts
 * grew the same need, so a fourth watermark-capable source costs a config
 * object, not a fourth copy of this file.
 */

import type { EventStore } from "../store.js";
import type { ImportResult, ParsedConversation } from "./extract.js";

/** A conversation carrying the per-message watermark arrays a source needs to
    support top-up. Ids/timestamps are parallel to `userMessages` ("" where the
    source had none for that particular message). */
export interface WatermarkedConversation extends ParsedConversation {
  messageIds: string[];
  messageTimestamps: string[];
}

// A resumed conversation tops up only once this many new messages have
// accrued — the daemon ticks every 30 min, and re-extracting a barely-grown
// conversation one message at a time would pay for the same context over and
// over.
const MIN_TOPUP_MESSAGES = 2;

/**
 * The suffix of a resumed conversation past its watermark, as its own
 * conversation: same uuid (topics attribute to the conversation, not to a
 * message range), timestamped at the first new message so decay treats the
 * activity as current, watermark advanced to the new tail's last message.
 * `assistantMessages`/`toolCommands` are deliberately NOT sliced — assistant
 * replies are context for extraction regardless of which user messages are
 * new, and tool conventions are mined across the whole session's commands
 * (deterministic, no cost to re-scan).
 */
export function topUpOf<C extends WatermarkedConversation>(c: C, from: number): C {
  const messageIds = c.messageIds.slice(from);
  return {
    ...c,
    userMessages: c.userMessages.slice(from),
    messageIds,
    messageTimestamps: c.messageTimestamps.slice(from),
    created_at: c.messageTimestamps[from] || c.created_at,
    lastMessageId: messageIds[messageIds.length - 1] || c.lastMessageId,
  };
}

export interface IncrementalImportResult {
  newConversations: number;
  toppedUp: number; // resumed conversations that contributed content past their watermark
  events: number;
  skipped: number; // already-seen conversations with nothing new past the watermark
  /** The engine failed outright, so nothing was marked as imported. The caller
      must back off: this content will otherwise be retried on every tick. */
  engineFailed: boolean;
}

export interface IncrementalSource<C extends WatermarkedConversation> {
  /** The fully-prefixed source string, e.g. "import:codex" — must match what
      extractEvents itself records, since seen/watermark lookups key on it. */
  source: string;
  /** Parses the source's current on-disk state. Whether there's anything to
      parse at all (the tool was never used, its directory doesn't exist) is
      the caller's job to check before calling this — see the per-source
      `importNew*` wrappers, each of which returns the empty result early on a
      missing root rather than making every caller re-check `existsSync`. */
  parse: () => { conversations: C[] };
  /** Runs extraction over exactly the jobs handed to it — already filtered to
      fresh + topped-up conversations — and returns the shared ImportResult
      shape (the same one every importer's own extract*Events wrapper returns). */
  extract: (jobs: C[]) => Promise<ImportResult>;
}

const emptyResult: IncrementalImportResult = { newConversations: 0, toppedUp: 0, events: 0, skipped: 0, engineFailed: false };

/**
 * Incrementally import a watermark-capable source: everything not already in
 * the store, plus the new tail of anything resumed since its last import.
 * Matched by `conversation_uuid`; resumed conversations are diffed against the
 * `message_uuid` watermark their last import recorded. A conversation with no
 * per-message ids (an older parse, or one that never produced any) can't be
 * diffed and never tops up — it imports whole exactly once, same as before
 * per-message watermarks existed at all.
 */
export async function runIncrementalImport<C extends WatermarkedConversation>(
  store: EventStore,
  cfg: IncrementalSource<C>,
): Promise<IncrementalImportResult> {
  const { conversations } = cfg.parse();
  if (!conversations.length) return emptyResult;

  const seen = store.importedConversationUuids(cfg.source);
  const marks = store.conversationWatermarks(cfg.source);

  const fresh: C[] = [];
  const topUps: C[] = [];
  let skipped = 0;
  for (const c of conversations) {
    if (!seen.has(c.uuid)) { fresh.push(c); continue; }
    const mark = marks.get(c.uuid);
    // No watermark (pre-watermark import, or a source that never produced one
    // for this conversation) or an id no longer present (rewritten/compacted
    // history): can't tell what's new — don't pay twice.
    const at = mark ? c.messageIds.lastIndexOf(mark) : -1;
    if (at === -1 || c.messageIds.length - (at + 1) < MIN_TOPUP_MESSAGES) { skipped++; continue; }
    topUps.push(topUpOf(c, at + 1));
  }

  const jobs = [...fresh, ...topUps];
  if (!jobs.length) return { ...emptyResult, skipped };
  const { events, extractionsSucceeded, extractionsFailed } = await cfg.extract(jobs);
  store.append(events);
  // Nothing extracted and something failed = the engine, not the content.
  // This stays unmarked and will retry, so the caller has to stop calling —
  // otherwise the same content is re-attempted every tick forever.
  const engineFailed = extractionsSucceeded === 0 && extractionsFailed > 0;
  return { newConversations: fresh.length, toppedUp: topUps.length, events: events.length, skipped, engineFailed };
}
