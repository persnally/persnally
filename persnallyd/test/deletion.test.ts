/**
 * Deletion is the load-bearing promise of the trust posture: the README says
 * "no tombstones, no residue", and the dashboard tells the user that forgetting
 * a topic removes its events and everything derived from them. Both claims are
 * falsifiable with `strings` and with a two-deep derivation chain, so they are
 * tested against the bytes on disk rather than against the query layer that
 * would happily hide a surviving row.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { newEvent } from "../src/events.js";
import { EventStore } from "../src/store.js";

const dirs: string[] = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function freshStore(): { store: EventStore; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "persnally-deletion-"));
  dirs.push(dir);
  const path = join(dir, "test.db");
  return { store: new EventStore(path), path };
}

/** Every byte SQLite persists for this database: the file, plus the WAL that
    holds pre-delete copies of pages until a checkpoint. */
function onDiskBytes(path: string): string {
  let raw = readFileSync(path).toString("latin1");
  for (const sidecar of [`${path}-wal`, `${path}-shm`]) {
    if (existsSync(sidecar)) raw += readFileSync(sidecar).toString("latin1");
  }
  return raw;
}

const topic = (name: string) =>
  newEvent("signal.topic", "import:claude", {
    topic: name, weight: 0.9, intent: "building", sentiment: "positive",
    depth: "deep", category: "health", entities: [],
  }, { kind: "import", batch: "batch-1", file: "conversations.json" });

describe("a forgotten topic leaves no residue on disk", () => {
  // A string that cannot collide with schema text, another test's data, or the
  // SQLite header — if it survives, it survived because the row did.
  const SECRET = "quokkazoomancy-diagnosis-9f3a";

  test("forgetTopic removes the content from the database file itself", () => {
    const { store, path } = freshStore();
    store.append([topic(SECRET)]);
    store.rebuild();
    assert.ok(onDiskBytes(path).includes(SECRET), "precondition: it is on disk while stored");

    store.forgetTopic(SECRET);

    assert.equal(
      onDiskBytes(path).includes(SECRET), false,
      "`strings persnally.db` must not find a topic the user forgot",
    );
    store.close();
  });

  test("forgetAll removes the content from the database file itself", () => {
    const { store, path } = freshStore();
    store.append([topic(SECRET)]);
    store.rebuild();
    assert.ok(onDiskBytes(path).includes(SECRET));

    store.forgetAll();

    assert.equal(onDiskBytes(path).includes(SECRET), false);
    store.close();
  });

  test("forgetBatch removes the content from the database file itself", () => {
    const { store, path } = freshStore();
    store.append([topic(SECRET)]);
    store.rebuild();
    assert.ok(onDiskBytes(path).includes(SECRET));

    store.forgetBatch("batch-1");

    assert.equal(onDiskBytes(path).includes(SECRET), false);
    store.close();
  });

  test("a forgotten style pattern leaves no residue either", () => {
    const { store, path } = freshStore();
    const pattern = "always says quokkazoomancy";
    store.append([newEvent("signal.style", "import:claude", {
      dimension: "emphasis", pattern, polarity: "does",
      confidence: 0.9, evidence: "seen often", basis: "stylometry",
    }, { kind: "import", batch: "batch-1", file: "conversations.json" })]);
    assert.ok(onDiskBytes(path).includes("quokkazoomancy"));

    store.forgetStyle("emphasis", pattern);

    // The tombstone deliberately survives (that is what keeps it from being
    // re-learned) and it stores a lowercased key — but the signal, its
    // evidence, and its original casing must be gone.
    const remaining = onDiskBytes(path);
    assert.equal(remaining.includes("seen often"), false, "the evidence text is gone");
    assert.equal(remaining.includes("stylometry"), false, "the signal row is gone");
    store.close();
  });
});

describe("deletion follows the whole derivation chain", () => {
  test("a grandchild derived from a derived event is deleted too", () => {
    const { store } = freshStore();
    const base = topic("kubernetes");
    store.append([base]);

    // child ← base, grandchild ← child. The nightly reflection genuinely
    // produces this shape: assertions derived from earlier assertions.
    const child = newEvent("signal.assertion", "system",
      { claim: "runs clusters", kind: "skill", confidence: 0.8, evidence: "topics" },
      { kind: "derived", from: [base.id] });
    store.append([child]);
    const grandchild = newEvent("signal.assertion", "system",
      { claim: "is an infra person", kind: "behavior", confidence: 0.7, evidence: "assertions" },
      { kind: "derived", from: [child.id] });
    store.append([grandchild]);
    store.rebuild();

    const deleted = store.forgetTopic("kubernetes");

    assert.equal(deleted, 3, "base, child, and grandchild");
    assert.equal(store.getEvents([grandchild.id]).length, 0, "the grandchild did not survive its source");
    assert.equal(store.stats().total, 0);
    store.close();
  });

  test("the walk is order-independent, not a single lucky pass", () => {
    const { store } = freshStore();
    const base = topic("postgres");
    const child = newEvent("signal.assertion", "system",
      { claim: "tunes databases", kind: "skill", confidence: 0.8, evidence: "topics" },
      { kind: "derived", from: [base.id] });
    const grandchild = newEvent("signal.assertion", "system",
      { claim: "is a backend person", kind: "behavior", confidence: 0.7, evidence: "assertions" },
      { kind: "derived", from: [child.id] });

    // Inserted grandchild-first, so a single pass over the derived rows sees
    // the grandchild before its parent is known to be doomed.
    store.append([grandchild]);
    store.append([child]);
    store.append([base]);
    store.rebuild();

    assert.equal(store.forgetTopic("postgres"), 3);
    assert.equal(store.stats().total, 0, "insertion order must not decide what survives");
    store.close();
  });

  test("events outside the chain are untouched", () => {
    const { store } = freshStore();
    const target = topic("rust");
    const bystander = topic("gardening");
    const derivedFromBystander = newEvent("signal.assertion", "system",
      { claim: "grows tomatoes", kind: "fact", confidence: 0.9, evidence: "topics" },
      { kind: "derived", from: [bystander.id] });
    store.append([target, bystander, derivedFromBystander]);
    store.rebuild();

    store.forgetTopic("rust");

    assert.equal(store.getEvents([bystander.id]).length, 1);
    assert.equal(store.getEvents([derivedFromBystander.id]).length, 1, "an unrelated derivation survives");
    store.close();
  });
});
