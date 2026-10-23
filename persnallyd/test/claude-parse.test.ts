import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { parseClaudeExport } from "../src/importers/claude.js";

const dir = mkdtempSync(join(tmpdir(), "claude-export-"));
after(() => rmSync(dir, { recursive: true, force: true }));

writeFileSync(join(dir, "conversations.json"), JSON.stringify([
  {
    uuid: "c1", name: "Debugging async", summary: "Fixed a gather bug",
    created_at: "2026-01-01T00:00:00Z",
    chat_messages: [
      { sender: "human", text: "why does asyncio gather hang" },
      { sender: "assistant", text: "because..." },
      { sender: "human", text: "", content: [{ type: "text", text: "fixed it, thanks" }] },
    ],
  },
]));
writeFileSync(join(dir, "memories.json"), JSON.stringify([{ conversations_memory: "Solo founder in Delhi." }]));
mkdirSync(join(dir, "projects"));
writeFileSync(join(dir, "projects", "p1.json"), JSON.stringify({ name: "Persnally", description: "context engine" }));
writeFileSync(join(dir, "projects", "starter.json"), JSON.stringify({ name: "How to", is_starter_project: true }));

test("parses user messages only, both text shapes", () => {
  const parsed = parseClaudeExport(dir);
  assert.equal(parsed.conversations.length, 1);
  assert.deepEqual(parsed.conversations[0]!.userMessages, ["why does asyncio gather hang", "fixed it, thanks"]);
});

test("includes memory text and non-starter projects", () => {
  const parsed = parseClaudeExport(dir);
  assert.match(parsed.memoryText, /Solo founder/);
  assert.deepEqual(parsed.projects, [{ name: "Persnally", description: "context engine" }]);
});

test("missing conversations.json fails loudly", () => {
  assert.throws(() => parseClaudeExport(tmpdir()), /No conversations.json/);
});

test("reads the newer memories/ folder layout", () => {
  const d = mkdtempSync(join(tmpdir(), "claude-export-new-"));
  try {
    writeFileSync(join(d, "conversations.json"), "[]");
    mkdirSync(join(d, "memories"));
    writeFileSync(join(d, "memories", "m1.json"), JSON.stringify({ conversations_memory: "Runs Ravox and Modelia." }));
    assert.match(parseClaudeExport(d).memoryText, /Runs Ravox/);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
