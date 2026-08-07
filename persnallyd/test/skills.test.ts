/**
 * `signal.skill` had a producer and no reader. The git importer — the only
 * key-free path, and the only one a user without an API key can run — emitted
 * skills that reached no profile, no context, and no answer. Written and never
 * surfaced.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { newEvent } from "../src/events.js";
import { synthesizeProfile } from "../src/profile.js";
import { EventStore } from "../src/store.js";

const dir = mkdtempSync(join(tmpdir(), "skills-"));
after(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
const freshStore = () => new EventStore(join(dir, `s${++n}.db`));

const skill = (name: string, domain: string, proficiency: number, repo: string) =>
  newEvent("signal.skill", "import:git", { skill: name, domain, proficiency, basis: `files-touched:${repo}` },
    { kind: "git", repo, batch: "b1" });

describe("skills aggregate across repos", () => {
  test("the same skill from several repos becomes one entry, counting its sources", () => {
    const store = freshStore();
    store.append([
      skill("TypeScript", "language", 0.6, "alpha"),
      skill("TypeScript", "language", 0.9, "beta"),
      skill("Rust", "language", 0.4, "gamma"),
    ]);

    const skills = store.skills();
    const ts = skills.find((k) => k.skill === "TypeScript");

    assert.ok(ts);
    assert.equal(ts.sources, 2, "two repos back it");
    assert.equal(ts.proficiency, 0.9, "the strongest observation wins, not the last one");
    assert.equal(skills.length, 2);
    store.close();
  });

  test("ranked by proficiency, so the strongest evidence leads", () => {
    const store = freshStore();
    store.append([
      skill("Go", "language", 0.2, "a"),
      skill("Python", "language", 0.8, "b"),
      skill("Ruby", "language", 0.5, "c"),
    ]);

    assert.deepEqual(store.skills().map((k) => k.skill), ["Python", "Ruby", "Go"]);
    store.close();
  });

  test("case variants are one skill, not several", () => {
    const store = freshStore();
    store.append([skill("typescript", "language", 0.5, "a"), skill("TypeScript", "language", 0.7, "b")]);
    assert.equal(store.skills().length, 1);
    store.close();
  });

  test("an empty store yields nothing rather than throwing", () => {
    const store = freshStore();
    assert.deepEqual(store.skills(), []);
    store.close();
  });
});

describe("skills reach the surfaces that matter", () => {
  test("profile synthesis is given them — this is the gap that made them write-only", async () => {
    const store = freshStore();
    store.append([
      newEvent("signal.topic", "import:git", {
        topic: "persnally", weight: 0.9, intent: "building", sentiment: "neutral",
        depth: "deep", category: "technology", entities: [],
      }, { kind: "git", repo: "persnally", batch: "b1" }),
      skill("TypeScript", "language", 0.9, "persnally"),
      skill("SQLite", "backend", 0.7, "persnally"),
    ]);
    store.rebuild();

    let seen = "";
    await synthesizeProfile(store, ({ content }) => {
      seen = content;
      return Promise.resolve({
        headline: "A builder",
        sections: [{ title: "Work", body: "Builds things.", evidence_event_ids: [] }],
      });
    }, "model");

    assert.match(seen, /Demonstrated skills/, "the profile prompt now includes them");
    assert.match(seen, /TypeScript/);
    assert.match(seen, /SQLite/);
    store.close();
  });

  test("a store with no skills produces no empty section in the prompt", async () => {
    const store = freshStore();
    store.append([newEvent("signal.topic", "import:claude", {
      topic: "rust", weight: 0.9, intent: "learning", sentiment: "neutral",
      depth: "deep", category: "technology", entities: [],
    }, { kind: "import", batch: "b1", file: "f" })]);
    store.rebuild();

    let seen = "";
    await synthesizeProfile(store, ({ content }) => {
      seen = content;
      return Promise.resolve({
        headline: "h", sections: [{ title: "t", body: "b", evidence_event_ids: [] }],
      });
    }, "model");

    assert.doesNotMatch(seen, /Demonstrated skills/, "no heading when there is nothing under it");
    store.close();
  });
});
