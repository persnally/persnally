import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { cursorUserDir, defaultCursorDb, DEFAULT_MAX_COMPOSERS, parseCursorHistory } from "../src/importers/cursor.js";

/**
 * Cursor publishes no export format or schema for this database — every shape
 * asserted here was read out of a real `state.vscdb` on a machine that has
 * used Cursor, not from documentation. Two tool-name generations coexisted in
 * that one file (`run_terminal_cmd` and `run_terminal_command_v2`, the latter
 * carrying its payload in `params` rather than `rawArgs`), which is why both
 * are fixtured rather than just the newer one.
 */

const root = mkdtempSync(join(tmpdir(), "cursor-import-"));
after(() => rmSync(root, { recursive: true, force: true }));

/** Builds a state.vscdb with the tables and shapes Cursor actually writes. */
function buildDb(
  home: string,
  composers: { id: string; workspaceId: string; createdAt: number; lastUpdatedAt: number; name: string; bubbles: unknown[] }[],
) {
  const dbPath = join(home, "state.vscdb");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
    CREATE TABLE composerHeaders (composerId TEXT PRIMARY KEY, workspaceId TEXT, createdAt INTEGER, lastUpdatedAt INTEGER);
  `);
  const put = db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)");
  const head = db.prepare("INSERT INTO composerHeaders (composerId, workspaceId, createdAt, lastUpdatedAt) VALUES (?, ?, ?, ?)");
  for (const c of composers) {
    head.run(c.id, c.workspaceId, c.createdAt, c.lastUpdatedAt);
    const headersOnly = c.bubbles.map((b) => ({ bubbleId: (b as { bubbleId: string }).bubbleId, type: (b as { type: number }).type }));
    put.run(`composerData:${c.id}`, JSON.stringify({ name: c.name, fullConversationHeadersOnly: headersOnly }));
    for (const b of c.bubbles) {
      const { bubbleId, ...rest } = b as { bubbleId: string };
      put.run(`bubbleId:${c.id}:${bubbleId}`, JSON.stringify(rest));
    }
  }
  db.close();
  return dbPath;
}

function workspace(home: string, id: string, folder: string) {
  const dir = join(cursorUserDir(home), "workspaceStorage", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "workspace.json"), JSON.stringify({ folder: `file://${folder}` }));
}

const bubble = (id: string, type: 1 | 2, text: string, toolFormerData?: unknown) => ({
  bubbleId: id, type, text, ...(toolFormerData ? { toolFormerData } : {}),
});

test("real composer/bubble shapes: roles, project, and both tool-name generations", () => {
  const home = join(root, "real-shapes");
  mkdirSync(join(cursorUserDir(home), "globalStorage"), { recursive: true });
  workspace(home, "ws-hash-abc123", "/Users/dev/Projects/widget");

  const dbPath = buildDb(join(cursorUserDir(home), "globalStorage"), [{
    id: "composer-1", workspaceId: "ws-hash-abc123", createdAt: 1_700_000_000_000, lastUpdatedAt: 1_700_000_100_000,
    name: "Add the widget settings sheet",
    bubbles: [
      bubble("b1", 1, "add a settings sheet to the widget view"),
      bubble("b2", 2, "Sure — here's the plan.", { name: "run_terminal_cmd", rawArgs: JSON.stringify({ command: "npm test" }) }),
      bubble("b3", 1, "also run the type checker"),
      bubble("b4", 2, "", { name: "run_terminal_command_v2", rawArgs: "", params: JSON.stringify({ command: "tsc --noEmit" }) }),
    ],
  }]);

  const { parsed, composersFound, composersDropped } = parseCursorHistory(dbPath, home);
  assert.equal(composersFound, 1);
  assert.equal(composersDropped, 0);
  assert.equal(parsed.conversations.length, 1);

  const c = parsed.conversations[0]!;
  assert.equal(c.uuid, "composer-1");
  assert.equal(c.name, "Add the widget settings sheet");
  assert.equal(c.project, "/Users/dev/Projects/widget", "the folder a workspace was opened on resolves to a project identity");
  assert.deepEqual(c.userMessages, ["add a settings sheet to the widget view", "also run the type checker"]);
  assert.deepEqual(c.assistantMessages, ["Sure — here's the plan."], "an empty-text tool-only turn contributes no assistant message");
  assert.deepEqual(c.toolCommands, ["npm test", "tsc --noEmit"],
    "both the old tool name (rawArgs) and the new one (params) are read");
});

test("a composer with no workspace history on this machine carries no project", () => {
  const home = join(root, "unknown-workspace");
  mkdirSync(join(cursorUserDir(home), "globalStorage"), { recursive: true });
  // No workspaceStorage/<id>/workspace.json written for this id — the
  // ordinary case for a workspace closed and pruned since the chat happened.
  const dbPath = buildDb(join(cursorUserDir(home), "globalStorage"), [{
    id: "composer-2", workspaceId: "some-pruned-id", createdAt: 1_700_000_000_000, lastUpdatedAt: 1_700_000_000_000,
    name: "orphaned chat",
    bubbles: [bubble("b1", 1, "hello"), bubble("b2", 1, "world"), bubble("b3", 2, "hi")],
  }]);

  const { parsed } = parseCursorHistory(dbPath, home);
  assert.equal(parsed.conversations[0]!.project, undefined);
});

test("an empty composer (window opened, nothing typed) is dropped, not just filtered thin", () => {
  const home = join(root, "empty-composer");
  mkdirSync(join(cursorUserDir(home), "globalStorage"), { recursive: true });
  const dbPath = buildDb(join(cursorUserDir(home), "globalStorage"), [
    { id: "empty", workspaceId: "w1", createdAt: 1, lastUpdatedAt: 1, name: "", bubbles: [] },
    { id: "one-message", workspaceId: "w1", createdAt: 2, lastUpdatedAt: 2, name: "", bubbles: [bubble("b1", 1, "single question")] },
    {
      id: "real", workspaceId: "w1", createdAt: 3, lastUpdatedAt: 3, name: "",
      bubbles: [bubble("b1", 1, "first"), bubble("b2", 1, "second")],
    },
  ]);

  const { parsed, composersFound } = parseCursorHistory(dbPath, home);
  assert.equal(composersFound, 3, "all three composers exist in the database");
  assert.deepEqual(parsed.conversations.map((c) => c.uuid), ["real"],
    "an empty composer and a below-threshold one are both dropped as noise, same bar as the other importers");
});

test("bubbles with an unknown type (a future Cursor message kind) are ignored, not crashed on", () => {
  const home = join(root, "unknown-type");
  mkdirSync(join(cursorUserDir(home), "globalStorage"), { recursive: true });
  const dbPath = buildDb(join(cursorUserDir(home), "globalStorage"), [{
    id: "composer-3", workspaceId: "w1", createdAt: 1, lastUpdatedAt: 1, name: "",
    bubbles: [bubble("b1", 1, "a"), bubble("b2", 1, "b"), { bubbleId: "b3", type: 7, text: "some future kind" }],
  }]);

  const { parsed } = parseCursorHistory(dbPath, home);
  assert.deepEqual(parsed.conversations[0]!.userMessages, ["a", "b"]);
  assert.deepEqual(parsed.conversations[0]!.assistantMessages, []);
});

test("composers beyond the cap are dropped, most-recently-updated kept", () => {
  const home = join(root, "capped");
  mkdirSync(join(cursorUserDir(home), "globalStorage"), { recursive: true });
  const composers = Array.from({ length: 5 }, (_, i) => ({
    id: `composer-${i}`, workspaceId: "w1", createdAt: i, lastUpdatedAt: i, name: "",
    bubbles: [bubble("b1", 1, "hi"), bubble("b2", 1, "again")],
  }));
  const dbPath = buildDb(join(cursorUserDir(home), "globalStorage"), composers);

  const { parsed, composersFound, composersDropped } = parseCursorHistory(dbPath, home, 2);
  assert.equal(composersFound, 5);
  assert.equal(composersDropped, 3);
  assert.deepEqual(parsed.conversations.map((c) => c.uuid).sort(), ["composer-3", "composer-4"],
    "the two most recently updated, not the two inserted first");
});

test("a missing database is a clear error, not a stack trace", () => {
  assert.throws(() => parseCursorHistory(join(root, "does-not-exist.vscdb")), /No Cursor chat history/);
});

test("defaultCursorDb resolves per-platform without touching a real filesystem path that doesn't exist", () => {
  const p = defaultCursorDb("/home/someone");
  assert.match(p, /Cursor.*User.*globalStorage.*state\.vscdb/);
});

test("the cap is a real constant, not a magic number duplicated at call sites", () => {
  assert.equal(DEFAULT_MAX_COMPOSERS, 200);
});
