/**
 * Extraction used to read only the user's half of every conversation — you
 * could see the questions but never the answers, so "what does this person
 * know?" and "what did they decide?" were unanswerable. Assistant replies now
 * reach the extractor as context.
 *
 * Two things must hold, and the second is the subtle one: the assistant's text
 * must never enter the voice corpus, or stylometry starts fingerprinting the
 * model's prose as the user's own.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { parseClaudeCodeTranscripts } from "../src/importers/claude-code.js";
import { parseChatGPTExport } from "../src/importers/chatgpt.js";
import { parseClaudeExport } from "../src/importers/claude.js";
import { extractEvents, type ParsedExport } from "../src/importers/extract.js";
import type { LlmExtract } from "../src/llm.js";

const dir = mkdtempSync(join(tmpdir(), "assistant-turns-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const noTopics: LlmExtract = () => Promise.resolve({ topics: [], assertions: [] });

/** Captures exactly what the extractor was asked to read. */
function spy(): { calls: string[]; extract: LlmExtract } {
  const calls: string[] = [];
  return {
    calls,
    extract: ({ content }) => { calls.push(content); return noTopics({} as never); },
  };
}

describe("all three parsers now collect the assistant's turns", () => {
  test("claude.ai export", () => {
    const d = join(dir, "claude-export");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "conversations.json"), JSON.stringify([{
      uuid: "c1", name: "db design", created_at: "2026-08-01T00:00:00Z",
      chat_messages: [
        { sender: "human", text: "should I use WAL mode?" },
        { sender: "assistant", text: "Yes — WAL allows concurrent readers during a write." },
      ],
    }]));

    const parsed = parseClaudeExport(d);

    assert.deepEqual(parsed.conversations[0]!.userMessages, ["should I use WAL mode?"]);
    assert.deepEqual(parsed.conversations[0]!.assistantMessages,
      ["Yes — WAL allows concurrent readers during a write."]);
  });

  test("chatgpt export", () => {
    const f = join(dir, "chatgpt.json");
    const node = (id: string, role: string, text: string, t: number) =>
      [id, { message: { author: { role }, create_time: t, content: { parts: [text] } } }];
    writeFileSync(f, JSON.stringify([{
      conversation_id: "g1", title: "rust", create_time: 1,
      mapping: Object.fromEntries([
        node("a", "user", "what does the borrow checker do?", 1),
        node("b", "assistant", "It enforces that references never outlive their owner.", 2),
      ]),
    }]));

    const parsed = parseChatGPTExport(f);

    assert.deepEqual(parsed.conversations[0]!.userMessages, ["what does the borrow checker do?"]);
    assert.deepEqual(parsed.conversations[0]!.assistantMessages,
      ["It enforces that references never outlive their owner."]);
  });

  test("claude code transcripts — assistant prose, not its tool calls", () => {
    const root = join(dir, "transcripts");
    mkdirSync(join(root, "-p"), { recursive: true });
    writeFileSync(join(root, "-p", "s1.jsonl"), [
      JSON.stringify({ type: "user", uuid: "u1", sessionId: "s1", cwd: "/x",
        timestamp: "2026-08-01T10:00:00Z", message: { role: "user", content: "why is the test flaky?" } }),
      JSON.stringify({ type: "assistant", uuid: "a1", sessionId: "s1",
        timestamp: "2026-08-01T10:01:00Z",
        message: { role: "assistant", content: [
          { type: "text", text: "The timeout races the retry — that's the flake." },
          { type: "tool_use", name: "Bash", input: { command: "npm test" } },
        ] } }),
      JSON.stringify({ type: "user", uuid: "u2", sessionId: "s1", cwd: "/x",
        timestamp: "2026-08-01T10:02:00Z", message: { role: "user", content: "fix it then" } }),
    ].join("\n") + "\n");

    const { parsed } = parseClaudeCodeTranscripts(root);
    const c = parsed.conversations[0]!;

    assert.deepEqual(c.userMessages, ["why is the test flaky?", "fix it then"]);
    assert.deepEqual(c.assistantMessages, ["The timeout races the retry — that's the flake."]);
    assert.ok(!JSON.stringify(c.assistantMessages).includes("npm test"),
      "tool_use blocks are not prose and must not leak in as assistant text");
  });
});

describe("the extractor sees the replies; the voice fingerprint does not", () => {
  const withReplies = (): ParsedExport => ({
    conversations: [{
      uuid: "c1", name: "chat", summary: "", created_at: "2026-08-01T00:00:00Z",
      userMessages: ["should we use postgres or sqlite here"],
      assistantMessages: ["Given a single-writer local daemon, SQLite in WAL mode is the better fit."],
    }],
    memoryText: "",
    projects: [],
  });

  test("assistant replies are included in the extraction prompt, labelled as context", async () => {
    const s = spy();
    await extractEvents(withReplies(), { source: "import:claude", importer: "claude", file: "f" }, s.extract, "m");

    assert.equal(s.calls.length, 1);
    assert.match(s.calls[0]!, /should we use postgres or sqlite/, "the user's half is still there");
    assert.match(s.calls[0]!, /SQLite in WAL mode is the better fit/, "and now the answer is too");
    assert.match(s.calls[0]!, /Assistant replies \(context only\)/,
      "labelled, so the model weights the user's engagement rather than the assistant's topics");
  });

  test("a conversation with no assistant turns is unchanged — no empty section", async () => {
    const s = spy();
    const parsed = withReplies();
    delete parsed.conversations[0]!.assistantMessages;

    await extractEvents(parsed, { source: "import:claude", importer: "claude", file: "f" }, s.extract, "m");

    assert.doesNotMatch(s.calls[0]!, /Assistant replies/);
  });

  test("assistant prose never reaches the voice fingerprint", async () => {
    const parsed: ParsedExport = {
      conversations: [{
        uuid: "c1", name: "chat", summary: "", created_at: "2026-08-01T00:00:00Z",
        // A distinctive user phrase repeated enough to register as stylometry,
        // against assistant prose with its own, different distinctive phrase.
        userMessages: Array.from({ length: 20 }, () => "be 100% sure about the analysis. fix it now."),
        assistantMessages: Array.from({ length: 20 }, () =>
          "Certainly! I would be delighted to elaborate on that particular consideration."),
      }],
      memoryText: "",
      projects: [],
    };

    const { events } = await extractEvents(
      parsed, { source: "import:claude", importer: "claude", file: "f" }, noTopics, "m");

    const style = JSON.stringify(events.filter((e) => e.type === "signal.style"));
    assert.ok(style.length > 2, "the fingerprint was derived at all");
    assert.doesNotMatch(style, /delighted|Certainly|elaborate/,
      "the model's writing must never be fingerprinted as the user's voice");
  });

  test("long replies are budgeted, keeping both the opening and the conclusion", async () => {
    const s = spy();
    const parsed: ParsedExport = {
      conversations: [{
        uuid: "c1", name: "chat", summary: "", created_at: "2026-08-01T00:00:00Z",
        userMessages: ["walk me through it"],
        assistantMessages: [
          "OPENING marker at the very start of the session.",
          ...Array.from({ length: 400 }, (_, i) => `filler paragraph number ${i} `.repeat(40)),
          "CONCLUSION marker: we settled on the append-only design.",
        ],
      }],
      memoryText: "",
      projects: [],
    };

    await extractEvents(parsed, { source: "import:claude", importer: "claude", file: "f" }, s.extract, "m");

    const sent = s.calls[0]!;
    assert.ok(sent.length < 60_000, "the prompt stays bounded rather than shipping the whole session");
    assert.match(sent, /OPENING marker/, "the start survives — it frames what the conversation is about");
    assert.match(sent, /CONCLUSION marker/, "and so does the end, where decisions actually land");
  });
});
