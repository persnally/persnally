/**
 * Export is the portability half of "it's yours". A bundle that silently drops
 * events, or that carries a credential out with them, would be worse than not
 * shipping one — so completeness and the absence of secrets are both asserted
 * rather than assumed.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { newEvent } from "../src/events.js";
import { buildBundle, EXPORT_FORMAT_VERSION, publicCut, renderMarkdown, type ExportBundle } from "../src/export.js";
import { dashboardKey, issueToken } from "../src/permissions.js";
import { EventStore } from "../src/store.js";

const dir = mkdtempSync(join(tmpdir(), "persnally-export-"));
process.env.PERSNALLY_DIR = dir;
const store = new EventStore(join(dir, "test.db"));
after(() => {
  store.close();
  delete process.env.PERSNALLY_DIR;
  rmSync(dir, { recursive: true, force: true });
});

let bundle: ExportBundle;
let key: string;
let token: string;

before(() => {
  store.append([
    newEvent("signal.topic", "import:claude", {
      topic: "SQLite | internals", weight: 0.9, intent: "learning", sentiment: "positive",
      depth: "deep", category: "technology", entities: ["WAL"],
    }, { kind: "import", batch: "b1", file: "conversations.json" }),
    newEvent("signal.style", "import:claude", {
      dimension: "voice", pattern: "terse imperatives", polarity: "does",
      confidence: 0.9, evidence: "3k prompts", basis: "stylometry",
    }, { kind: "import", batch: "b1", file: "conversations.json" }),
    newEvent("user.correction", "cli", {
      target_id: "role", action: "contradict", reason: "is a founder, not a contractor",
    }, { kind: "local", surface: "cli" }),
  ]);
  store.rebuild();
  store.saveProfile({
    headline: "A verification-obsessed builder",
    sections: [{ title: "How they work", body: "Ships in small,\nverified steps.", evidence_event_ids: [] }],
    generated_at: "2026-08-07T00:00:00Z",
    model: "claude-opus-4-8",
  });
  // Credentials exist while the bundle is built — the point of the leak test.
  key = dashboardKey();
  token = issueToken("cursor");
  bundle = buildBundle(store, "2.10.0", new Date("2026-08-07T12:00:00Z"));
});

describe("the JSON bundle is complete", () => {
  test("it carries every event, not a page of them", () => {
    assert.equal(bundle.events.length, store.stats().total);
    assert.equal(bundle.counts.events, bundle.events.length);
  });

  test("it carries the derived layers too, so a reader needs nothing else", () => {
    assert.equal(bundle.profile?.headline, "A verification-obsessed builder");
    assert.ok(bundle.topics.length > 0);
    assert.ok(bundle.voice.items.length > 0);
    assert.equal(bundle.corrections.length, 1);
  });

  test("it is self-describing, so a future importer can tell what it has", () => {
    assert.equal(bundle.format_version, EXPORT_FORMAT_VERSION);
    assert.equal(bundle.exported_at, "2026-08-07T12:00:00.000Z");
    assert.match(bundle.generator, /^persnally 2\.10\.0$/);
  });

  test("it round-trips through JSON unchanged", () => {
    assert.deepEqual(JSON.parse(JSON.stringify(bundle)), bundle);
  });

  test("the events are re-appendable into a fresh store — the log is the source of truth", () => {
    const other = new EventStore(join(dir, "restored.db"));
    assert.doesNotThrow(() => other.append(bundle.events), "exported events must still validate");
    other.rebuild();
    assert.equal(other.stats().total, bundle.events.length);
    assert.ok(other.topics().some((t) => t.topic === "SQLite | internals"), "and re-derive the same views");
    other.close();
  });
});

describe("no credential leaves with the data", () => {
  test("neither the dashboard key nor a client token appears anywhere in the bundle", () => {
    const serialized = JSON.stringify(bundle);
    assert.ok(key.length > 20 && token.length > 20, "precondition: real secrets exist to leak");
    assert.equal(serialized.includes(key), false, "the dashboard key must never be exported");
    assert.equal(serialized.includes(token), false, "nor a client's identity token");
  });
});

describe("the markdown portrait is readable", () => {
  test("it leads with the headline and includes the sections", () => {
    const md = renderMarkdown(bundle);
    assert.match(md, /^# Your Persnally context/);
    assert.match(md, /## A verification-obsessed builder/);
    assert.match(md, /### How they work/);
    assert.match(md, /## How you write/);
  });

  test("a pipe in a topic cannot break the table, and neither can a newline in a body", () => {
    const md = renderMarkdown(bundle);
    const row = md.split("\n").find((l) => l.includes("SQLite"))!;
    assert.match(row, /SQLite \\\| internals/, "the pipe is escaped");
    // Split on delimiters only — an escaped pipe is content, not a cell edge.
    assert.equal(row.split(/(?<!\\)\|/).length, 6, "still exactly four cells");
  });

  test("a backslash before a pipe cannot escape the cell — topic names are client-writable", () => {
    // Escaping the pipe alone turns `\|` into `\\|`: Markdown reads the pair as
    // one literal backslash, leaving the pipe live. A prompt-injected client
    // could write such a topic through persnally_track and break out of its cell.
    const s = new EventStore(join(dir, "inject.db"));
    s.append([newEvent("signal.topic", "mcp:cursor", {
      topic: String.raw`safe\| INJECTED`, weight: 0.9, intent: "building",
      sentiment: "neutral", depth: "deep", category: "technology", entities: [],
    }, { kind: "mcp", client: "cursor" })]);
    s.rebuild();

    const row = renderMarkdown(buildBundle(s, "3.0.0")).split("\n").find((l) => l.includes("INJECTED"))!;
    s.close();

    // Walk it the way Markdown does: `\X` consumes two characters, so a
    // backslash that is itself escaped no longer protects what follows.
    let cells = 0;
    for (let i = 0; i < row.length; i++) {
      if (row[i] === "\\") { i++; continue; }
      if (row[i] === "|") cells++;
    }
    assert.equal(cells, 5, `the row must keep exactly four cells, got ${cells - 1}: ${row}`);
  });

  test("an empty store produces a bundle that says so rather than throwing", () => {
    const empty = new EventStore(join(dir, "empty.db"));
    const b = buildBundle(empty, "2.10.0");
    assert.equal(b.counts.events, 0);
    assert.equal(b.profile, null);
    assert.match(renderMarkdown(b), /No profile synthesized yet/);
    empty.close();
  });
});

describe("the public cut carries only what a category can vouch for", () => {
  const prov = { kind: "import", batch: "b1", file: "conversations.json" } as const;
  const topic = (name: string, category: string) => newEvent("signal.topic", "import:claude", {
    topic: name, weight: 0.9, intent: "building", sentiment: "neutral", depth: "deep", category, entities: [],
  }, prov);
  const style = (dimension: string, pattern: string) => newEvent("signal.style", "import:claude", {
    dimension, pattern, polarity: "does", confidence: 0.9, evidence: "seen often", basis: "observed",
  }, prov);
  let cut: ExportBundle;
  let md: string;

  before(() => {
    const s = new EventStore(join(dir, "public.db"));
    s.append([
      topic("home loan refinancing", "finance"),
      topic("thyroid medication", "health"),
      topic("apartment hunting", "lifestyle"),
      topic("SQLite internals", "technology"),
      style("voice", "terse imperatives"),
      style("emphasis", "never mention the loan to the bank"),
      newEvent("user.correction", "cli", {
        target_id: "pay", action: "contradict", reason: "paid in USD, not INR",
      }, { kind: "local", surface: "cli" }),
    ]);
    s.rebuild();
    s.saveProfile({
      headline: "Someone refinancing a loan",
      sections: [{ title: "Money", body: "Carries a home loan.", evidence_event_ids: [] }],
      generated_at: "2026-08-07T00:00:00Z", model: "m",
    });
    const full = buildBundle(s, "3.2.0", new Date("2026-09-22T12:00:00Z"));
    s.close();
    cut = publicCut(full, {
      headline: "A database tinkerer",
      sections: [{ title: "What they build", body: "Reads SQLite internals.", evidence_event_ids: [] }],
      generated_at: "2026-09-22T00:00:00Z", model: "m",
    });
    md = renderMarkdown(cut);
  });

  test("private-category topics are gone, public ones stay, and the header says what was stripped", () => {
    assert.deepEqual(cut.topics.map((t) => t.topic), ["SQLite internals"]);
    assert.match(md, /SQLite internals/);
    assert.match(md, /Public cut: finance, health, lifestyle stripped \(3 topics\)/);
  });

  test("the narrative is the public one — the full portrait's prose never reaches it", () => {
    assert.match(md, /## A database tinkerer/);
    assert.doesNotMatch(md, /loan/i);
  });

  test("nothing uncategorized survives anywhere in the cut: corrections, verbatim phrasing, the event log", () => {
    const everything = JSON.stringify(cut);
    for (const leak of ["loan", "thyroid", "apartment", "paid in USD"]) {
      assert.ok(!everything.includes(leak), `"${leak}" leaked into the public cut`);
    }
    assert.equal(cut.events.length, 0);
    assert.match(md, /terse imperatives/);
  });

  test("with no public narrative yet it says so instead of falling back to the full portrait", () => {
    assert.match(renderMarkdown(publicCut(cut, null)), /No profile synthesized yet/);
  });
});
