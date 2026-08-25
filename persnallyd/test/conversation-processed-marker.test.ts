/**
 * A conversation whose extraction call SUCCEEDS but genuinely finds nothing
 * topic-worthy produced zero `signal.topic` events — indistinguishable from
 * "never attempted," since that was the only event type carrying
 * `conversation_uuid`. Every future plain `persnally import` would re-pay to
 * re-analyze it, forever, since nothing ever recorded that a working engine
 * already looked and found nothing.
 *
 * `system.conversation_processed` closes this: written once per conversation
 * whenever the call itself succeeds, regardless of topic count. Store-side,
 * `importedConversationUuids`/`conversationWatermarks` already query by
 * `source` + field presence rather than event type, so no store.ts change was
 * needed — these tests prove that claim rather than assume it.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { extractEvents, freshConversations, type ParsedConversation } from "../src/importers/extract.js";
import type { LlmExtract } from "../src/llm.js";
import { EventStore } from "../src/store.js";

const dbDir = mkdtempSync(join(tmpdir(), "processed-marker-"));
const store = new EventStore(join(dbDir, "test.db"));
after(() => { store.close(); rmSync(dbDir, { recursive: true, force: true }); });

const convo = (uuid: string): ParsedConversation =>
  ({ uuid, name: uuid, summary: "", created_at: "2026-06-01T10:00:00Z", userMessages: ["a real prompt about something specific"] });

const SOURCE = "import:claude-code";

test("a successful call with zero topics still gets a processed marker", async () => {
  const emptyExtract: LlmExtract = async () => ({ topics: [] });
  const { events } = await extractEvents({ conversations: [convo("empty-convo")], memoryText: "", projects: [] },
    { source: SOURCE, importer: "claude-code", file: "x" }, emptyExtract);

  const topics = events.filter((e) => e.type === "signal.topic");
  const processed = events.filter((e) => e.type === "system.conversation_processed");
  assert.equal(topics.length, 0, "genuinely nothing topic-worthy");
  assert.equal(processed.length, 1, "but the attempt itself is recorded");
  assert.equal(processed[0]!.provenance.kind, "import");
  assert.equal((processed[0]!.provenance as { conversation_uuid?: string }).conversation_uuid, "empty-convo");
  assert.equal((processed[0]!.payload as { topics_found: number }).topics_found, 0);
});

test("a successful call WITH topics gets both a topic event and a processed marker", async () => {
  const richExtract: LlmExtract = async () => ({
    topics: [{ topic: "a", weight: 0.5, intent: "building", sentiment: "neutral", depth: "moderate", category: "technology", entities: [] }],
  });
  const { events } = await extractEvents({ conversations: [convo("rich-convo")], memoryText: "", projects: [] },
    { source: SOURCE, importer: "claude-code", file: "x" }, richExtract);

  assert.equal(events.filter((e) => e.type === "signal.topic").length, 1);
  const processed = events.filter((e) => e.type === "system.conversation_processed");
  assert.equal(processed.length, 1);
  assert.equal((processed[0]!.payload as { topics_found: number }).topics_found, 1);
});

test("a failed call gets no processed marker — this conversation must still retry", async () => {
  const deadExtract: LlmExtract = async () => { throw new Error("dead engine"); };
  const { events, extractionsFailed } = await extractEvents({ conversations: [convo("failed-convo")], memoryText: "", projects: [] },
    { source: SOURCE, importer: "claude-code", file: "x" }, deadExtract);

  assert.ok(extractionsFailed > 0);
  assert.equal(events.filter((e) => e.type === "system.conversation_processed").length, 0,
    "a failed attempt is not a processed one — nothing here should stop it from retrying");
});

/**
 * The actual behavior this exists to fix, proven end to end through a real
 * store: a topic-less conversation stops being re-offered to extraction on
 * the next pass, while a failed one keeps being offered.
 */
test("the fix, end to end: a topic-less conversation is not retried; a failed one still is", async () => {
  const emptyExtract: LlmExtract = async () => ({ topics: [] });
  const deadExtract: LlmExtract = async () => { throw new Error("dead engine"); };

  const first = await extractEvents(
    { conversations: [convo("topic-less"), convo("engine-failed")], memoryText: "", projects: [] },
    { source: SOURCE, importer: "claude-code", file: "x" },
    async (opts) => {
      // Route by which conversation is being asked about, via the content string.
      if (opts.content.includes("topic-less")) return emptyExtract(opts);
      return deadExtract(opts);
    },
  );
  store.append(first.events);

  const seen = store.importedConversationUuids(SOURCE);
  assert.ok(seen.has("topic-less"), "recorded as seen even with zero topics");
  assert.ok(!seen.has("engine-failed"), "a failed attempt must not be recorded as seen");

  const { parsed } = freshConversations(
    { conversations: [convo("topic-less"), convo("engine-failed")], memoryText: "", projects: [] },
    seen,
  );
  assert.deepEqual(parsed.conversations.map((c) => c.uuid), ["engine-failed"],
    "only the failed one is offered again — the topic-less one correctly stopped being retried");
});

test("conversationWatermarks also picks up a topic-less conversation's marker (matters for future top-up)", async () => {
  const dir2 = mkdtempSync(join(tmpdir(), "processed-marker-watermark-"));
  const store2 = new EventStore(join(dir2, "test.db"));
  try {
    const emptyExtract: LlmExtract = async () => ({ topics: [] });
    const c: ParsedConversation = { ...convo("watermark-convo"), lastMessageId: "msg-42" };
    const { events } = await extractEvents({ conversations: [c], memoryText: "", projects: [] },
      { source: SOURCE, importer: "claude-code", file: "x" }, emptyExtract);
    store2.append(events);

    const marks = store2.conversationWatermarks(SOURCE);
    assert.equal(marks.get("watermark-convo"), "msg-42",
      "a topic-less conversation's watermark is still recoverable — a resumed session that stays quiet can still be diffed correctly next time");
  } finally {
    store2.close();
    rmSync(dir2, { recursive: true, force: true });
  }
});
