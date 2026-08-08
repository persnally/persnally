/**
 * Two sources the user wrote *about themselves*, both previously discarded:
 *
 * - ChatGPT Custom Instructions rode in the export as a system message and were
 *   dropped by the `role === "user"` filter — the highest signal-per-byte
 *   artifact in the file, sitting unparsed.
 * - Claude's `conversations_memory` was snapshotted only on the first import of
 *   a source, so a memory that grows for months never contributed again.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { parseChatGPTExport } from "../src/importers/chatgpt.js";
import { freshConversations, memorySnapshotHash, type ParsedExport } from "../src/importers/extract.js";

const dir = mkdtempSync(join(tmpdir(), "self-authored-"));
after(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
function exportWith(mapping: Record<string, unknown>): ParsedExport {
  const f = join(dir, `c${++n}.json`);
  writeFileSync(f, JSON.stringify([{ conversation_id: "g1", title: "t", create_time: 1, mapping }]));
  return parseChatGPTExport(f);
}

const userTurn = { message: { author: { role: "user" }, create_time: 2, content: { parts: ["hello"] } } };

describe("ChatGPT custom instructions", () => {
  test("the structured shape is read into memoryText", () => {
    const parsed = exportWith({
      sys: {
        message: {
          author: { role: "system" },
          metadata: {
            is_user_system_message: true,
            user_context_message_data: {
              about_user_message: "I'm a solo founder building local-first developer tools.",
              about_model_message: "Be terse. Lead with the answer.",
            },
          },
          content: { parts: [""] },
        },
      },
      u: userTurn,
    });

    assert.match(parsed.memoryText, /solo founder building local-first developer tools/);
    assert.match(parsed.memoryText, /Be terse\. Lead with the answer\./);
    assert.match(parsed.memoryText, /says about themselves/, "labelled so extraction knows whose words these are");
  });

  test("the older shape — instructions straight in content.parts — is read too", () => {
    const parsed = exportWith({
      sys: {
        message: {
          author: { role: "system" },
          metadata: { is_user_system_message: true },
          content: { parts: ["I prefer TypeScript and dislike heavy frameworks."] },
        },
      },
      u: userTurn,
    });

    assert.match(parsed.memoryText, /prefer TypeScript and dislike heavy frameworks/);
  });

  test("an unflagged system prompt is ignored — a custom GPT's words are not the user's", () => {
    const parsed = exportWith({
      sys: {
        message: {
          author: { role: "system" },
          // No is_user_system_message: this is a custom GPT's instructions.
          content: { parts: ["You are a pirate. Always answer in pirate speak."] },
        },
      },
      u: userTurn,
    });

    assert.equal(parsed.memoryText, "",
      "scraping arbitrary system prompts would poison the profile with someone else's words");
  });

  test("instructions repeated across every conversation are captured once", () => {
    const f = join(dir, "many.json");
    const sys = {
      message: {
        author: { role: "system" },
        metadata: { is_user_system_message: true, user_context_message_data: { about_user_message: "I ship fast." } },
        content: { parts: [""] },
      },
    };
    writeFileSync(f, JSON.stringify([
      { conversation_id: "a", title: "a", create_time: 1, mapping: { sys, u: userTurn } },
      { conversation_id: "b", title: "b", create_time: 2, mapping: { sys, u: userTurn } },
      { conversation_id: "c", title: "c", create_time: 3, mapping: { sys, u: userTurn } },
    ]));

    const parsed = parseChatGPTExport(f);

    assert.equal(parsed.memoryText.match(/I ship fast\./g)?.length, 1,
      "the same instructions appear in every conversation — extract them once, not once per chat");
  });

  test("an export with no instructions yields no memory text", () => {
    assert.equal(exportWith({ u: userTurn }).memoryText, "");
  });
});

describe("memory is re-read when it changes, not once forever", () => {
  const base = (memoryText: string): ParsedExport => ({
    conversations: [{ uuid: "c1", name: "n", summary: "", created_at: "2026-08-01T00:00:00Z", userMessages: ["hi"] }],
    memoryText,
    projects: [],
  });

  test("unchanged memory is skipped on re-import — no paying twice for the same text", () => {
    const parsed = base("the user is a founder");
    const hash = memorySnapshotHash(parsed);

    const r = freshConversations(parsed, new Set(["c1"]), new Set([hash]));

    assert.equal(r.parsed.memoryText, "", "already extracted from this exact snapshot");
    assert.equal(r.memoryHash, "", "nothing new to mark");
  });

  test("grown memory is re-imported even though the source was seen before", () => {
    const grown = base("the user is a founder, and now also ships an audiobook product");

    const r = freshConversations(grown, new Set(["c1"]), new Set([memorySnapshotHash(base("the user is a founder"))]));

    assert.match(r.parsed.memoryText, /audiobook/,
      "this is the bug: memory grows continuously and was captured only once");
    assert.equal(r.memoryHash, memorySnapshotHash(grown), "the new snapshot is returned for marking");
  });

  test("projects count toward the snapshot, order-independently", () => {
    const withProjects = (projects: { name: string; description: string }[]): ParsedExport =>
      ({ ...base("m"), projects });
    const a = withProjects([{ name: "x", description: "1" }, { name: "y", description: "2" }]);
    const b = withProjects([{ name: "y", description: "2" }, { name: "x", description: "1" }]);
    const c = withProjects([{ name: "x", description: "1" }, { name: "z", description: "3" }]);

    assert.equal(memorySnapshotHash(a), memorySnapshotHash(b), "reordering is not a change");
    assert.notEqual(memorySnapshotHash(a), memorySnapshotHash(c), "a different project is");
  });

  test("an empty snapshot hashes to nothing and is never marked", () => {
    const empty = base("");
    assert.equal(memorySnapshotHash(empty), "");
    assert.equal(freshConversations(empty, new Set(), new Set()).memoryHash, "");
  });

  test("conversation dedup still works alongside the memory decision", () => {
    const parsed: ParsedExport = {
      conversations: [
        { uuid: "old", name: "n", summary: "", created_at: "2026-08-01T00:00:00Z", userMessages: ["a"] },
        { uuid: "new", name: "n", summary: "", created_at: "2026-08-02T00:00:00Z", userMessages: ["b"] },
      ],
      memoryText: "m",
      projects: [],
    };

    const r = freshConversations(parsed, new Set(["old"]), new Set());

    assert.deepEqual(r.parsed.conversations.map((c) => c.uuid), ["new"]);
    assert.equal(r.skipped, 1);
  });
});
