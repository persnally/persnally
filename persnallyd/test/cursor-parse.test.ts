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

/**
 * Nothing here has a published schema, so JSON.parse accepting a value as
 * *syntax* says nothing about whether it's the *shape* this code expects. One
 * malformed composer used to throw out of the whole loop and abort every other
 * composer's import along with it — found by review, reproduced against a real
 * fixture before being fixed.
 */
test("a structurally malformed composer does not abort the ones around it", () => {
  const home = join(root, "malformed-shapes");
  mkdirSync(join(cursorUserDir(home), "globalStorage"), { recursive: true });
  const dbPath = join(cursorUserDir(home), "globalStorage", "state.vscdb");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
    CREATE TABLE composerHeaders (composerId TEXT PRIMARY KEY, workspaceId TEXT, createdAt INTEGER, lastUpdatedAt INTEGER);
  `);
  const put = db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)");
  const head = db.prepare("INSERT INTO composerHeaders (composerId, workspaceId, createdAt, lastUpdatedAt) VALUES (?, ?, ?, ?)");

  // A real, well-formed composer — this is what must survive the others being broken.
  head.run("good", "w1", 1_700_000_000_000, 1_700_000_000_000);
  put.run("composerData:good", JSON.stringify({ name: "a real chat", fullConversationHeadersOnly: [{ bubbleId: "b1", type: 1 }, { bubbleId: "b2", type: 1 }] }));
  put.run("bubbleId:good:b1", JSON.stringify({ type: 1, text: "first message" }));
  put.run("bubbleId:good:b2", JSON.stringify({ type: 1, text: "second message" }));

  // fullConversationHeadersOnly is an object, not an array — `for...of` on it throws.
  head.run("bad-headers-shape", "w1", 1_700_000_001_000, 1_700_000_001_000);
  put.run("composerData:bad-headers-shape", JSON.stringify({ name: "x", fullConversationHeadersOnly: {} }));

  // name is a number, not a string — `.trim()` on it throws.
  head.run("bad-name-type", "w1", 1_700_000_002_000, 1_700_000_002_000);
  put.run("composerData:bad-name-type", JSON.stringify({ name: 12345, fullConversationHeadersOnly: [{ bubbleId: "c1", type: 1 }, { bubbleId: "c2", type: 1 }] }));
  put.run("bubbleId:bad-name-type:c1", JSON.stringify({ type: 1, text: "one" }));
  put.run("bubbleId:bad-name-type:c2", JSON.stringify({ type: 1, text: "two" }));

  // createdAt is not a valid timestamp — new Date(...).toISOString() throws RangeError.
  head.run("bad-created-at", "w1", NaN, NaN);
  put.run("composerData:bad-created-at", JSON.stringify({ name: "y", fullConversationHeadersOnly: [{ bubbleId: "d1", type: 1 }, { bubbleId: "d2", type: 1 }] }));
  put.run("bubbleId:bad-created-at:d1", JSON.stringify({ type: 1, text: "three" }));
  put.run("bubbleId:bad-created-at:d2", JSON.stringify({ type: 1, text: "four" }));

  // A bubble reference whose bubbleId is missing entirely.
  head.run("bad-ref-shape", "w1", 1_700_000_004_000, 1_700_000_004_000);
  put.run("composerData:bad-ref-shape", JSON.stringify({ name: "z", fullConversationHeadersOnly: [{ notABubbleId: true }, { bubbleId: "e1", type: 1 }, { bubbleId: "e2", type: 1 }] }));
  put.run("bubbleId:bad-ref-shape:e1", JSON.stringify({ type: 1, text: "five" }));
  put.run("bubbleId:bad-ref-shape:e2", JSON.stringify({ type: 1, text: "six" }));

  // A bubble whose text is not a string. Two good messages alongside it so the
  // composer clears MIN_USER_MESSAGES on its own — the point under test is that
  // the malformed one doesn't crash, not that it counts.
  head.run("bad-text-type", "w1", 1_700_000_005_000, 1_700_000_005_000);
  put.run("composerData:bad-text-type", JSON.stringify({ name: "w", fullConversationHeadersOnly: [{ bubbleId: "f1", type: 1 }, { bubbleId: "f2", type: 1 }, { bubbleId: "f3", type: 1 }] }));
  put.run("bubbleId:bad-text-type:f1", JSON.stringify({ type: 1, text: 999 }));
  put.run("bubbleId:bad-text-type:f2", JSON.stringify({ type: 1, text: "seven" }));
  put.run("bubbleId:bad-text-type:f3", JSON.stringify({ type: 1, text: "eight" }));

  db.close();

  const { parsed, composersFound } = parseCursorHistory(dbPath, home);
  assert.equal(composersFound, 6, "all six rows exist in the database");
  const byId = new Map(parsed.conversations.map((c) => [c.uuid, c]));

  assert.ok(byId.has("good"), "a well-formed composer must survive its neighbors being malformed");
  assert.deepEqual(byId.get("good")!.userMessages, ["first message", "second message"]);

  // Empty headers -> zero messages -> below MIN_USER_MESSAGES -> correctly
  // dropped as noise. The point is that it is *dropped*, not *thrown*.
  assert.ok(!byId.has("bad-headers-shape"));

  assert.ok(byId.has("bad-name-type"), "a non-string name falls back to the generated label instead of throwing");
  assert.match(byId.get("bad-name-type")!.name, /Cursor session|^$/);

  assert.ok(byId.has("bad-created-at"), "an unparseable createdAt falls back to a valid timestamp instead of throwing");
  assert.doesNotThrow(() => new Date(byId.get("bad-created-at")!.created_at));

  assert.ok(byId.has("bad-ref-shape"), "one malformed reference in the list is skipped, the rest of that composer still parses");
  assert.deepEqual(byId.get("bad-ref-shape")!.userMessages, ["five", "six"]);

  assert.ok(byId.has("bad-text-type"), "a non-string bubble text is treated as empty, not thrown on");
  assert.deepEqual(byId.get("bad-text-type")!.userMessages, ["seven", "eight"]);
});
