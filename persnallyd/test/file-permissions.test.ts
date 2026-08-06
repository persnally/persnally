/**
 * Every credential check the daemon performs assumes the files underneath it
 * are not simply readable by anyone on the machine. `permissions.ts` says so
 * explicitly — it argues the dashboard key is safe because config is 0600 —
 * so the store, its WAL, the log, the telemetry file and the client configs
 * that carry bearer tokens are held to the same bar.
 */

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { newEvent } from "../src/events.js";
import { ensurePrivateDir, ensurePrivateFile } from "../src/paths.js";
import { EventStore } from "../src/store.js";

const dirs: string[] = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "persnally-perms-"));
  dirs.push(d);
  return d;
}

/** The permission bits, ignoring file type — 0o600, 0o700, 0o644. */
const mode = (p: string) => statSync(p).mode & 0o777;

/** Group and other must hold no bits at all: not read, not write, not execute. */
const ownerOnly = (p: string) => (statSync(p).mode & 0o077) === 0;

describe("the event store is not world-readable", () => {
  test("the database, its WAL, and the directory are owner-only", () => {
    const dir = join(tmp(), "nested");
    const db = join(dir, "persnally.db");
    const store = new EventStore(db);
    // Force a WAL write so -wal and -shm actually exist to be checked.
    store.append([newEvent("signal.topic", "import:claude", {
      topic: "private matter", weight: 0.9, intent: "learning", sentiment: "neutral",
      depth: "deep", category: "health", entities: [],
    }, { kind: "import", batch: "b1", file: "conversations.json" })]);

    assert.equal(mode(dir), 0o700, "the directory is the real boundary against other users");
    assert.ok(ownerOnly(db), `db is ${mode(db).toString(8)}`);
    for (const sidecar of [`${db}-wal`, `${db}-shm`]) {
      if (existsSync(sidecar)) assert.ok(ownerOnly(sidecar), `${sidecar} is ${mode(sidecar).toString(8)}`);
    }
    store.close();
  });

  test("an install created before this is tightened on open, not left as it was", () => {
    const dir = tmp();
    const db = join(dir, "persnally.db");
    // Simulate the state every existing user is in today.
    chmodSync(dir, 0o755);
    writeFileSync(db, "", { mode: 0o644 });

    const store = new EventStore(db);

    assert.equal(mode(dir), 0o700, "mkdirSync ignores mode on an existing dir — chmod has to follow");
    assert.ok(ownerOnly(db));
    store.close();
  });
});

describe("the helpers hold their contract", () => {
  test("ensurePrivateDir creates and tightens", () => {
    const dir = join(tmp(), "fresh");
    ensurePrivateDir(dir);
    assert.equal(mode(dir), 0o700);
  });

  test("ensurePrivateFile tightens an existing loose file", () => {
    const f = join(tmp(), "loose.json");
    writeFileSync(f, "{}", { mode: 0o644 });
    ensurePrivateFile(f);
    assert.equal(mode(f), 0o600);
  });

  test("a missing file is not an error — callers harden opportunistically", () => {
    assert.doesNotThrow(() => ensurePrivateFile(join(tmp(), "never-created.json")));
  });
});
