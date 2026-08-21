// Seed and start an isolated daemon for the e2e suite. Parametrized by env:
//   E2E_PORT   — port to listen on
//   E2E_DIR    — PERSNALLY_DIR (fresh per run)
//   E2E_BADKEY — when "1", store an invalid Anthropic key so every ask/synthesis
//                exercises the error path deterministically (key outranks Ollama)
//   E2E_EMPTY  — when "1", seed nothing: the fresh-install path a new user hits
//   E2E_RICH   — when "1", also seed skills, reflections, reads and an answered
//                ask, so the panels that need history have something to render
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
const EMPTY = process.env.E2E_EMPTY === "1";

const mk = (topic, category, intent, entities = []) =>
  newEvent("signal.topic", "import:chatgpt", {
    topic, weight: 0.6, intent, sentiment: "positive", depth: "moderate", category, entities,
  }, { kind: "import", batch: "b1", file: "conversations.json", conversation_uuid: `c-${topic.length}` });

const topics = EMPTY ? [] : [
  mk("PostgreSQL query planning", "technology", "debugging", ["EXPLAIN"]),
  mk("integration tests before merging", "technology", "deciding", ["playwright"]),
  mk("pricing strategy for a solo SaaS", "business", "researching", ["PLG"]),
  mk("disposable topic for deletion test", "technology", "building", []),
  mk("marathon training block", "health", "learning", []),
];
if (topics.length) store.append(topics);

if (!EMPTY) store.append([
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
// Panels that need history: skills, reflections, a read audit across days and
// clients, and one answered ask that can be judged.
if (process.env.E2E_RICH === "1") {
  const day = (n) => new Date(Date.now() - n * 86_400_000).toISOString();
  const skills = [
    ["TypeScript", "language", 0.9],
    ["SQLite", "datastore", 0.75],
    ["Playwright", "testing", 0.6],
  ].map(([skill, domain, proficiency]) =>
    newEvent("signal.skill", "import:git", { skill, domain, proficiency, basis: "commit history" },
      { kind: "git", repo: "persnally" }));

  const reflections = [
    ["Ships behind a test before calling it done", 0.92],
    ["Prefers deleting code to abstracting it", 0.81],
  ].map(([claim, confidence]) =>
    newEvent("signal.assertion", "system", { claim, kind: "behavior", confidence, evidence: "recurring across sessions" },
      { kind: "derived", from: [topics[0].id] }));

  const reads = [];
  for (const [n, client, items] of [[0, "cursor", 12], [0, "claude-code", 8], [1, "claude-code", 5], [2, "cursor", 3], [4, "claude-desktop", 9]]) {
    const e = newEvent("context.read", `mcp:${client}`, { scope: "technology", client_purpose: "session start", items },
      { kind: "mcp", client, session: `s-${n}${client.length}` });
    reads.push({ ...e, ts: day(n) });
  }
  // A CLI read: the owner's own, and must not be counted as a grantee client.
  reads.push({ ...newEvent("context.read", "cli", { scope: "all", client_purpose: "hook", items: 20 }, { kind: "local", surface: "cli" }), ts: day(0) });

  const q = newEvent("agent.question", "mcp:cursor", { question: "does he prefer npm or pnpm?", asker: "cursor" }, { kind: "mcp", client: "cursor" });
  const a = newEvent("agent.answer", "mcp:cursor", {
    question_id: q.id, answer: "npm — he insists on it in every repo.", confidence: 0.88,
    deferred: false, evidence_event_ids: [topics[0].id],
  }, { kind: "mcp", client: "cursor" });

  // A second ask citing different evidence: reopening one after the other is
  // how cross-ask evidence contamination shows up.
  const q2 = newEvent("agent.question", "mcp:claude-code", { question: "should this ship behind a flag?", asker: "claude-code" }, { kind: "mcp", client: "claude-code" });
  const a2 = newEvent("agent.answer", "mcp:claude-code", {
    question_id: q2.id, answer: "Yes — he ships behind a test, then a flag.", confidence: 0.82,
    deferred: false, evidence_event_ids: [topics[1].id, topics[2].id],
  }, { kind: "mcp", client: "claude-code" });

  store.append([...skills, ...reflections, ...reads, q, a, q2, a2]);
}

store.rebuild();

// E2E_NOPROFILE=1 leaves the store portrait-less so the greeting state is testable;
// an empty store has nothing to synthesize from, so it gets no portrait either.
if (process.env.E2E_NOPROFILE !== "1" && !EMPTY) {
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
