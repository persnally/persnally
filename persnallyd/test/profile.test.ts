import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { newEvent } from "../src/events.js";
import { synthesizeProfile } from "../src/profile.js";
import { EventStore } from "../src/store.js";

const dir = mkdtempSync(join(tmpdir(), "profile-test-"));
const store = new EventStore(join(dir, "test.db"));
after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

test("synthesize fails loudly on an empty store", async () => {
  await assert.rejects(() => synthesizeProfile(store, async () => ({})), /Nothing to synthesize/);
});

test("synthesizes, persists, and round-trips a profile with evidence ids", async () => {
  const topicEvent = newEvent("signal.topic", "import:claude", {
    topic: "event sourcing", weight: 0.9, intent: "building", sentiment: "positive",
    depth: "deep", category: "technology", entities: ["SQLite"],
  }, { kind: "import", batch: "b1", file: "conversations.json" });
  const assertionEvent = newEvent("signal.assertion", "import:claude", {
    claim: "solo founder", kind: "context", confidence: 0.9, evidence: "memory",
  }, { kind: "import", batch: "b1", file: "memories.json" });
  store.append([topicEvent, assertionEvent]);
  store.rebuild();

  let seenContent = "";
  const profile = await synthesizeProfile(store, async ({ content }) => {
    seenContent = content;
    return {
      headline: "A builder",
      sections: [{ title: "Work", body: "Builds things.", evidence_event_ids: [assertionEvent.id] }],
    };
  });

  assert.match(seenContent, /event sourcing/);
  assert.match(seenContent, /solo founder/);
  assert.match(seenContent, new RegExp(assertionEvent.id));

  const stored = store.getProfile();
  assert.equal(stored?.headline, "A builder");
  assert.deepEqual(stored?.sections[0]?.evidence_event_ids, [assertionEvent.id]);
});

test("malformed LLM output is rejected, leaving the stored profile intact", async () => {
  await assert.rejects(() => synthesizeProfile(store, async () => ({ headline: "", sections: [] })));
  assert.equal(store.getProfile()?.headline, "A builder");
});

/**
 * "Every claim cites its evidence" is the dashboard's central trust claim, and
 * an id that resolves to nothing is rendered there as "evidence not found
 * (deleted?)" — which blames the user's deletion for a citation the model may
 * simply have invented. A fabricated citation must never reach the store.
 */
test("an invented evidence id is dropped rather than stored", async () => {
  const real = store.query({ type: "signal.assertion" })[0]!;

  const profile = await synthesizeProfile(store, async () => ({
    headline: "A builder",
    sections: [{
      title: "Work",
      body: "Builds things.",
      evidence_event_ids: [real.id, "01890000-0000-7000-8000-nosuchevent"],
    }],
  }));

  assert.deepEqual(profile.sections[0]?.evidence_event_ids, [real.id], "the invented id is gone");
  assert.deepEqual(store.getProfile()?.sections[0]?.evidence_event_ids, [real.id], "and never reached the store");
});

test("a section citing only invented ids keeps its prose but loses the citations", async () => {
  const profile = await synthesizeProfile(store, async () => ({
    headline: "A builder",
    sections: [{ title: "Guesswork", body: "Unsupported claim.", evidence_event_ids: ["totally-made-up"] }],
  }));

  assert.equal(profile.sections[0]?.body, "Unsupported claim.", "the section survives");
  assert.deepEqual(profile.sections[0]?.evidence_event_ids, [], "with nothing to click through to");
});

test("legitimate ids offered in the prompt are all preserved", async () => {
  const topicHeadId = store.topics(30)[0]!.event_ids[0]!;
  const assertionId = store.query({ type: "signal.assertion" })[0]!.id;

  const profile = await synthesizeProfile(store, async () => ({
    headline: "A builder",
    sections: [{ title: "Work", body: "Builds things.", evidence_event_ids: [topicHeadId, assertionId] }],
  }));

  assert.deepEqual(
    profile.sections[0]?.evidence_event_ids.sort(), [topicHeadId, assertionId].sort(),
    "pruning must not eat real citations",
  );
});
