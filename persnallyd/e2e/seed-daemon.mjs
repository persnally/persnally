// Seed and start an isolated daemon for the e2e suite. Parametrized by env:
//   E2E_PORT   — port to listen on
//   E2E_DIR    — PERSNALLY_DIR (fresh per run)
//   E2E_BADKEY — when "1", store an invalid Anthropic key so every ask/synthesis
//                exercises the error path deterministically (key outranks Ollama)
// Prints "KEY=<dashboard key>" so the runner can authenticate.
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const port = Number(process.env.E2E_PORT ?? 4998);
const dir = process.env.E2E_DIR ?? "/tmp/persnally-e2e";
mkdirSync(dir, { recursive: true });
process.env.PERSNALLY_DIR = dir;
delete process.env.ANTHROPIC_API_KEY;

const { EventStore } = await import("../build/src/store.js");
const { newEvent } = await import("../build/src/events.js");
const { startDaemon } = await import("../build/src/daemon.js");
const { dashboardKey, issueToken, setScope } = await import("../build/src/permissions.js");
const { saveConfig, applyApiKey } = await import("../build/src/config.js");

if (process.env.E2E_BADKEY === "1") {
  saveConfig({ anthropic_api_key: "sk-ant-invalid-e2e-error-path" });
  applyApiKey(); // config → env, as real daemon startup does — key must outrank Ollama
}

const store = new EventStore(join(dir, "e2e.db"));

const mk = (topic, category, intent, entities = []) =>
  newEvent("signal.topic", "import:chatgpt", {
    topic, weight: 0.6, intent, sentiment: "positive", depth: "moderate", category, entities,
  }, { kind: "import", batch: "b1", file: "conversations.json", conversation_uuid: `c-${topic.length}` });

const topics = [
  mk("PostgreSQL query planning", "technology", "debugging", ["EXPLAIN"]),
  mk("integration tests before merging", "technology", "deciding", ["playwright"]),
  mk("pricing strategy for a solo SaaS", "business", "researching", ["PLG"]),
  mk("disposable topic for deletion test", "technology", "building", []),
  mk("marathon training block", "health", "learning", []),
];
store.append(topics);

store.append([
  newEvent("signal.style", "import:chatgpt", {
    dimension: "convention", pattern: "npm, never pnpm", polarity: "insists",
    confidence: 0.8, evidence: "every repo", basis: "observed",
  }, { kind: "import", batch: "b1", file: "conversations.json" }),
  newEvent("signal.style", "import:chatgpt", {
    dimension: "voice", pattern: "disposable style for deletion test", polarity: "does",
    confidence: 0.6, evidence: "seeded", basis: "stylometry",
  }, { kind: "import", batch: "b1", file: "conversations.json" }),
  newEvent("signal.assertion", "system", {
    claim: "Demands observable proof before calling anything done",
    kind: "behavior", confidence: 0.9, evidence: "recurring",
  }, { kind: "derived", from: [topics[0].id, topics[1].id] }),
  newEvent("system.import", "system", {
    importer: "chatgpt", batch: "b1", events: 7, extractor_version: 3,
    source_span: ["2026-06-01T00:00:00Z", "2026-08-01T00:00:00Z"],
  }, { kind: "import", batch: "b1", file: "conversations.json" }),
]);
store.rebuild();

// E2E_NOPROFILE=1 leaves the store portrait-less so the greeting state is testable.
if (process.env.E2E_NOPROFILE !== "1") {
  store.saveProfile({
    headline: "A builder who verifies before shipping",
    sections: [
      { title: "How you build", body: "Small increments, observable proof, no faith-based shipping.", evidence_event_ids: [topics[1].id] },
    ],
    generated_at: new Date().toISOString(),
    model: "seed",
  });
}

issueToken("cursor");
setScope("cursor", ["technology"]);

startDaemon(store, port);
console.log(`E2E daemon on :${port}`);
console.log("KEY=" + dashboardKey());
