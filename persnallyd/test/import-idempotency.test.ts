import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { freshConversations, readImportFile, type ParsedConversation, type ParsedExport } from "../src/importers/extract.js";
import { extractClaudeEvents } from "../src/importers/claude.js";
import { gitEvents } from "../src/importers/git.js";
import type { RepoSummary } from "../src/importers/git.js";
import type { LlmExtract } from "../src/llm.js";
import { EventStore } from "../src/store.js";

const dbDir = mkdtempSync(join(tmpdir(), "idempotency-db-"));
const store = new EventStore(join(dbDir, "test.db"));
after(() => { store.close(); rmSync(dbDir, { recursive: true, force: true }); });

let extractCalls = 0;
const extract: LlmExtract = async () => {
  extractCalls++;
  return { topics: [{ topic: "t", weight: 0.5, intent: "building", sentiment: "neutral", depth: "moderate", category: "technology", entities: [] }] };
};
const convo = (uuid: string): ParsedConversation => ({ uuid, name: uuid, summary: "", created_at: "2026-06-01T10:00:00Z", userMessages: ["a real prompt about something"] });
const repo = (name: string): RepoSummary => ({ repo: name, path: `/x/${name}`, commits: 12, firstCommit: "2026-01-01T00:00:00Z", lastCommit: "2026-06-01T00:00:00Z", frameworks: ["react"] });

test("freshConversations keeps everything (and the one-time memory) on the first import", () => {
  const parsed: ParsedExport = { conversations: [convo("a"), convo("b")], memoryText: "remember me", projects: [{ name: "p", description: "d" }] };
  const r = freshConversations(parsed, new Set());
  assert.equal(r.firstImport, true);
  assert.equal(r.skipped, 0);
  assert.equal(r.parsed.conversations.length, 2);
  assert.equal(r.parsed.memoryText, "remember me", "memory kept on first import");
});

// Memory used to be gated on "is this the first import", which meant a memory
// that grows for months only ever contributed once. It is keyed by content
// hash now: re-read when it changed, skipped when it didn't. Both halves are
// asserted here rather than only the skip.
test("freshConversations drops already-seen conversations but re-reads memory that changed", () => {
  const parsed: ParsedExport = { conversations: [convo("a"), convo("b"), convo("c")], memoryText: "remember me", projects: [{ name: "p", description: "d" }] };
  const r = freshConversations(parsed, new Set(["a", "b"]));
  assert.equal(r.firstImport, false);
  assert.equal(r.skipped, 2);
  assert.deepEqual(r.parsed.conversations.map((c) => c.uuid), ["c"]);
  assert.equal(r.parsed.memoryText, "remember me", "this snapshot has not been extracted from before");
  assert.deepEqual(r.parsed.projects, [{ name: "p", description: "d" }]);
});

test("freshConversations skips memory it has already extracted from", () => {
  const parsed: ParsedExport = { conversations: [convo("a"), convo("c")], memoryText: "remember me", projects: [{ name: "p", description: "d" }] };
  const seenHash = freshConversations(parsed, new Set()).memoryHash;
  assert.ok(seenHash, "the first pass reports a hash to record");

  const r = freshConversations(parsed, new Set(["a"]), new Set([seenHash]));

  assert.equal(r.parsed.memoryText, "", "identical memory is not paid for twice");
  assert.deepEqual(r.parsed.projects, []);
  assert.equal(r.memoryHash, "");
});

test("a conversation with no uuid can't be deduped, so it's always treated as fresh", () => {
  const parsed: ParsedExport = { conversations: [convo("")], memoryText: "", projects: [] };
  const r = freshConversations(parsed, new Set(["x"]));
  assert.equal(r.parsed.conversations.length, 1);
});

test("re-importing the same Claude export is a no-op; a new conversation tops up without doubling", async () => {
  const parsed: ParsedExport = { conversations: [convo("c1"), convo("c2")], memoryText: "", projects: [] };

  // First import.
  const f1 = freshConversations(parsed, store.importedConversationUuids("import:claude"));
  const r1 = await extractClaudeEvents(f1.parsed, extract, "model");
  store.append(r1.events);
  store.rebuild();
  const totalAfterFirst = store.stats().total;
  assert.deepEqual([...store.importedConversationUuids("import:claude")].sort(), ["c1", "c2"]);

  // Re-import the identical export: nothing fresh, so the CLI would append nothing.
  const f2 = freshConversations(parsed, store.importedConversationUuids("import:claude"));
  assert.equal(f2.firstImport, false);
  assert.equal(f2.parsed.conversations.length, 0);
  assert.equal(store.stats().total, totalAfterFirst, "no events added on a duplicate import");

  // Export grew by one conversation: only the new one is extracted.
  const grown: ParsedExport = { conversations: [convo("c1"), convo("c2"), convo("c3")], memoryText: "", projects: [] };
  const callsBefore = extractCalls;
  const f3 = freshConversations(grown, store.importedConversationUuids("import:claude"));
  assert.equal(f3.parsed.conversations.length, 1);
  const r3 = await extractClaudeEvents(f3.parsed, extract, "model");
  store.append(r3.events);
  store.rebuild();
  assert.equal(extractCalls, callsBefore + 1, "the extractor ran for exactly the one new conversation");
  assert.deepEqual([...store.importedConversationUuids("import:claude")].sort(), ["c1", "c2", "c3"]);
});

test("git re-import skips repos already on file", () => {
  const gitDir = mkdtempSync(join(tmpdir(), "idempotency-git-"));
  const gitStore = new EventStore(join(gitDir, "test.db"));
  after(() => { gitStore.close(); rmSync(gitDir, { recursive: true, force: true }); });

  gitStore.append(gitEvents([repo("alpha")]).events);
  assert.deepEqual([...gitStore.importedGitRepos()].sort(), ["alpha"]);

  const summaries = [repo("alpha"), repo("beta")];
  const fresh = summaries.filter((s) => !gitStore.importedGitRepos().has(s.repo));
  assert.deepEqual(fresh.map((s) => s.repo), ["beta"], "only the unseen repo is fresh");

  gitStore.append(gitEvents(fresh).events);
  assert.deepEqual([...gitStore.importedGitRepos()].sort(), ["alpha", "beta"]);
  assert.equal([repo("alpha"), repo("beta")].filter((s) => !gitStore.importedGitRepos().has(s.repo)).length, 0, "nothing new on a third pass");
});

test("readImportFile refuses a file over the size limit with a clear message", () => {
  const f = join(dbDir, "export.json");
  writeFileSync(f, "[]");
  assert.equal(readImportFile(f), "[]", "a small file reads fine");
  assert.throws(() => readImportFile(f, 1), /over the .* import limit/, "an oversized file is rejected, not parsed");
});
