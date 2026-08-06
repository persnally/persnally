#!/usr/bin/env node
/**
 * persnallyd CLI — the developer's window into the daemon.
 * Merges into the `persnally` npm identity at Phase 1 launch.
 */

import { execFileSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { applyApiKey, configPath, loadConfig, saveConfig } from "./config.js";
import { CLIENTS, connectAll, connectClient, installClaudeCodeHook, type Client } from "./connect.js";
import { runConsolidation } from "./consolidate.js";
import { buildBundle, renderMarkdown } from "./export.js";
import { chooseExtractor } from "./llm.js";
import { CATEGORIES, clearScope, dashboardKey, loadScopes, rotateDashboardKey, setScope, type Category } from "./permissions.js";
import { alreadyImported, DENSITY_QUESTIONS, detectExports, eventsFromAnswers, isThin, markImported } from "./setup.js";
import { autoImportNewSessions, DEFAULT_PORT, startDaemon, VERSION } from "./daemon.js";
import { extractChatGPTEvents, parseChatGPTExport } from "./importers/chatgpt.js";
import { extractClaudeEvents, parseClaudeExport } from "./importers/claude.js";
import {
  DEFAULT_TRANSCRIPTS_DIR, extractClaudeCodeEvents, parseClaudeCodeTranscripts,
} from "./importers/claude-code.js";
import { gitEvents, scanRepos } from "./importers/git.js";
import { freshConversations, type ParsedExport } from "./importers/extract.js";
import {
  autostartInstalled, installAutostart, LOG_FILE, reloadAutostart, removeAutostart,
  removePidFile, runningPid, startDetached, stopDaemon, writePidFile,
} from "./lifecycle.js";
import { newEvent } from "./events.js";
import { refreshVoice } from "./voice.js";
import { refreshScopedProfiles, renderProfile, synthesizeProfile, synthesizeScopedProfile } from "./profile.js";
import { askUserModel } from "./ask.js";
import { renderHits, searchContext } from "./search.js";
import { DEFAULT_DB_PATH, EventStore } from "./store.js";

const USAGE = `persnallyd ${VERSION} — so every AI finally knows you

Usage:
  persnallyd setup                  One command: find exports, import, synthesize, connect, open
  persnallyd connect [client|--all] [--scope cats]  Add Persnally to claude-code | claude-desktop | cursor (optionally scope it inline)
  persnallyd scope <client> <categories|--clear>   Limit what a client can read (e.g. scope cursor technology,career)
  persnallyd scope                  Show all client scopes
  persnallyd init                   Create the local store (~/.persnally/persnally.db)
  persnallyd import claude <dir>    Import a Claude data export (needs ANTHROPIC_API_KEY)
  persnallyd import claude-code [dir]  Import Claude Code session transcripts (default ~/.claude/projects)
  persnallyd import chatgpt <path>  Import a ChatGPT export dir or conversations.json (needs ANTHROPIC_API_KEY)
  persnallyd import git <path> [--author <email>]   Import repo activity (offline, no LLM); path = repo or folder of repos
  persnallyd profile                Synthesize your profile from the store
  persnallyd ask "<question>"       Ask your model a question the way an agent would (answers or defers)
  persnallyd search "<topic>"       What Persnally knows about a specific subject (offline, no LLM)
  persnallyd correct "<truth>" [--about <subject>]   Correct something it believes about you (authoritative)
  persnallyd voice                  Refresh your voice fingerprint from Claude Code transcripts (offline, no LLM)
  persnallyd consolidate            Reflect now: refresh decay, add behavior patterns, re-synthesize
  persnallyd show [topics|events|profile]   Show topics (default), recent events, or the profile
  persnallyd context [--full]       Emit profile + interests for AI injection (records a context read)
  persnallyd export [--md] [--out <file>]   Take everything with you (JSON by default; --md for a readable portrait)
  persnallyd forget <topic>         Hard-delete a topic and everything derived from it
  persnallyd forget --style <dimension> <pattern>   Forget a "how you write" pattern for good
  persnallyd forget --all           Delete all data
  persnallyd forget --batch <id>    Undo one import batch
  persnallyd dashboard [--rotate]   Open the local dashboard (--rotate signs out open browser sessions)
  persnallyd status                 Store stats and daemon health
  persnallyd activity [--json]      Context-read engagement over time (retention pulse)
  persnallyd start [--port N]       Start the daemon in the background
  persnallyd stop                   Stop the background daemon
  persnallyd restart                Restart the daemon (correctly handles autostart/launchd)
  persnallyd serve [--port N]       Run the daemon in the foreground (127.0.0.1:${DEFAULT_PORT})
  persnallyd autostart [--remove]   Start the daemon at login and keep it alive (macOS launchd · Linux systemd)
  persnallyd config set-key <key>   Store the Anthropic API key (owner-only file) for the daemon
  persnallyd config                 Show config (key masked)
`;

function parsePort(args: string[]): number {
  const i = args.indexOf("--port");
  return i > -1 && args[i + 1] ? Number(args[i + 1]) : DEFAULT_PORT;
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  applyApiKey();
  switch (cmd) {
    case "setup": {
      const port = parsePort(args);
      console.log("Persnally setup — so every AI finally knows you.\n");

      // 1. Extraction engine (optional — git-only works without one)
      let engine = null;
      try {
        engine = await chooseExtractor("extract");
        console.log(`✓ Extraction engine: ${engine.label}`);
      } catch {
        console.log("· No extraction engine (no API key, no Ollama) — conversation imports skipped, git still works.");
      }

      // 2. Daemon
      if (!runningPid()) {
        await startDetached(process.argv[1]!, port);
        console.log(`✓ Daemon started (http://127.0.0.1:${port})`);
      } else {
        console.log("✓ Daemon already running");
      }

      // 3. Conversation exports from ~/Downloads (zipped or unzipped)
      const store = new EventStore();
      let imported = 0;
      for (const found of detectExports()) {
        if (alreadyImported(found.origin)) {
          console.log(`· Skipping ${found.origin} (already imported)`);
        } else if (engine) {
          console.log(`→ Importing ${found.kind} export: ${found.origin}`);
          const parsed = found.kind === "claude" ? parseClaudeExport(found.path) : parseChatGPTExport(found.path);
          const result = found.kind === "claude"
            ? await extractClaudeEvents(parsed, engine.extract, engine.model)
            : await extractChatGPTEvents(parsed, engine.extract, engine.model);
          store.append(result.events);
          markImported(found.origin);
          imported += result.events.length;
          console.log(`  ✓ ${result.events.length} events`);
        }
        if (found.cleanup) rmSync(found.cleanup, { recursive: true, force: true });
      }

      // 3b. Claude Code transcripts — local, no export wait. Capped at the 50 most
      // recent sessions so setup stays fast; full history via `import claude-code`.
      if (engine && existsSync(DEFAULT_TRANSCRIPTS_DIR) && !alreadyImported(DEFAULT_TRANSCRIPTS_DIR)) {
        const { parsed, sessionsFound, sessionsDropped } = parseClaudeCodeTranscripts(DEFAULT_TRANSCRIPTS_DIR, 50);
        if (parsed.conversations.length) {
          console.log(
            `→ Importing Claude Code transcripts: ${parsed.conversations.length} session(s)` +
            (sessionsDropped ? ` (most recent of ${sessionsFound} — full history: persnallyd import claude-code)` : ""),
          );
          const result = await extractClaudeCodeEvents(parsed, engine.extract, engine.model);
          store.append(result.events);
          markImported(DEFAULT_TRANSCRIPTS_DIR);
          imported += result.events.length;
          console.log(`  ✓ ${result.events.length} events`);
        }
      }

      // 4. Git activity from ~/Projects
      const projects = join(homedir(), "Projects");
      if (existsSync(projects) && !alreadyImported(projects)) {
        const summaries = scanRepos(projects);
        if (summaries.length) {
          const { events } = gitEvents(summaries);
          store.append(events);
          markImported(projects);
          imported += events.length;
          console.log(`✓ Imported ${summaries.length} git repo(s) from ~/Projects (${events.length} events, fully offline)`);
        }
      }
      store.rebuild();

      // 4b. Density floor — if everything is still thin, two questions beat an empty mirror
      const signalCount = store.stats().byType["signal.topic"] ?? 0;
      if (isThin(signalCount) && process.stdin.isTTY) {
        console.log("\nYour history is light — two quick questions so Persnally starts with something real:");
        const { createInterface } = await import("node:readline/promises");
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const answers: string[] = [];
        for (const q of DENSITY_QUESTIONS) answers.push(await rl.question(`  ${q}\n  > `));
        rl.close();
        const seeds = await eventsFromAnswers(answers, engine);
        if (seeds.length) {
          store.append(seeds);
          store.rebuild();
          imported += seeds.length;
          console.log(`  ✓ Seeded ${seeds.length} signal(s) from your answers`);
        }
      }

      // 5. Profile
      if (engine && store.stats().total > 0) {
        console.log("→ Synthesizing your profile…");
        const profileEngine = await chooseExtractor("profile");
        await synthesizeProfile(store, profileEngine.extract, profileEngine.model);
        console.log("  ✓ Profile ready");
      }
      store.close();

      // 6. AI clients
      const connections = connectAll();
      for (const { client, file } of connections) {
        console.log(file ? `✓ Connected ${client}` : `· ${client} not installed — skipped`);
      }
      if (connections.some((r) => r.client === "claude-code" && r.file)) {
        try { installClaudeCodeHook(); console.log("✓ Context hook installed (injects on every Claude Code session)"); }
        catch (e) { console.error(`· Context hook skipped: ${e instanceof Error ? e.message : String(e)}`); }
      }

      console.log(`\nDone${imported ? ` — ${imported} events imported` : ""}.`);
      announceDashboard(port);
      return;
    }
    case "scope": {
      const [client, spec] = args;
      if (!client) {
        const scopes = loadScopes();
        const entries = Object.entries(scopes);
        if (!entries.length) { console.log("No client scopes — every connected client sees everything."); return; }
        for (const [c, cats] of entries) console.log(`${c}: ${cats.join(", ")}`);
        return;
      }
      if (!spec) return die("usage: persnallyd scope <client> <cat1,cat2|--clear>");
      if (spec === "--clear") {
        console.log(clearScope(client) ? `Cleared scope for ${client} — it now sees everything.` : `${client} had no scope.`);
        return;
      }
      const cats = spec.split(",").map((c) => c.trim()).filter(Boolean);
      const invalid = cats.filter((c) => !CATEGORIES.includes(c as Category));
      if (invalid.length) return die(`unknown categor${invalid.length > 1 ? "ies" : "y"}: ${invalid.join(", ")}\nvalid: ${CATEGORIES.join(", ")}`);
      setScope(client, cats as Category[]);
      console.log(`${client} can now read only: ${cats.join(", ")}. Restart that client to apply.`);
      // Give the scope its own narrative right away, so the client isn't profile-less.
      const scopeEngine = await chooseExtractor("profile").catch(() => null);
      if (scopeEngine) {
        const store = new EventStore();
        try {
          const scoped = await synthesizeScopedProfile(store, cats as Category[], scopeEngine.extract, scopeEngine.model);
          console.log(scoped
            ? `Synthesized a ${cats.join("+")}-only profile for scoped clients.`
            : `No ${cats.join("/")} topics yet — scoped clients get topics only until there's material.`);
        } catch (e) {
          console.error(`Scoped profile not synthesized (${e instanceof Error ? e.message : String(e)}) — it will be built on the next synthesis.`);
        } finally {
          store.close();
        }
      } else {
        console.log("No engine available — the scoped profile will be built on the next synthesis.");
      }
      return;
    }
    case "connect": {
      // Optional inline scope: `connect <client> --scope tech,career`. Strip it
      // out first so it doesn't get read as the client positional.
      const rest = [...args];
      let scopeCats: Category[] | null = null;
      const si = rest.indexOf("--scope");
      if (si >= 0) {
        const spec = rest[si + 1] ?? "";
        rest.splice(si, spec && !spec.startsWith("--") ? 2 : 1);
        const cats = spec.split(",").map((c) => c.trim()).filter(Boolean);
        const invalid = cats.filter((c) => !CATEGORIES.includes(c as Category));
        if (!cats.length || invalid.length) return die(`--scope needs valid categories: ${CATEGORIES.join(", ")}`);
        scopeCats = cats as Category[];
      }
      const target = rest[0] === "--all" || !rest[0] ? null : (rest[0] as Client);
      if (target && !CLIENTS.includes(target)) return die(`unknown client — use ${CLIENTS.join(" | ")} | --all`);
      if (scopeCats && !target) return die("--scope needs a specific client (not --all)");
      const results = target ? [{ client: target, file: connectClient(target) }] : connectAll();
      for (const { client, file } of results) {
        console.log(file ? `Connected ${client} (${file})` : `${client} not installed — skipped`);
      }
      // Connect mints the client's identity token into its MCP env — a running
      // client keeps the old env until relaunched.
      if (results.some((r) => r.file)) {
        console.log("  ↳ identity token issued — restart the client(s) to pick it up");
      }
      // Inline scope applies to the named client (it's config; takes effect whenever that client reads).
      if (scopeCats && target) {
        setScope(target, scopeCats);
        console.log(`  ↳ scoped ${target} to: ${scopeCats.join(", ")} (it reads only these)`);
      }
      // Claude Code also gets a SessionStart hook so every session injects context automatically.
      if (results.some((r) => r.client === "claude-code" && r.file)) {
        try {
          console.log(`Installed Claude Code context hook (${installClaudeCodeHook()})`);
        } catch (e) {
          console.error(`Context hook not installed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      return;
    }
    case "config": {
      if (args[0] === "set-key") {
        if (!args[1]?.startsWith("sk-ant-")) return die("expected an Anthropic key (sk-ant-...)");
        saveConfig({ anthropic_api_key: args[1] });
        console.log(`Key saved to ${configPath()} (mode 600). Restart the daemon to apply: persnallyd stop`);
        return;
      }
      const cfg = loadConfig();
      const key = typeof cfg.anthropic_api_key === "string" ? cfg.anthropic_api_key : "";
      console.log(`Config: ${configPath()}`);
      console.log(`anthropic_api_key: ${key ? key.slice(0, 12) + "…" + key.slice(-4) : "(not set)"}`);
      return;
    }
    case "init": {
      const store = new EventStore();
      store.close();
      console.log(`Initialized ${DEFAULT_DB_PATH}`);
      return;
    }
    case "import": {
      const [kind, path] = args;
      const usage = "usage: persnallyd import claude|claude-code|chatgpt|git <path>";
      if (!kind) return die(usage);

      // Git: offline, deterministic. Dedup by repo so a re-run never doubles the graph.
      if (kind === "git") {
        if (!path) return die(usage);
        const authorIdx = args.indexOf("--author");
        const summaries = scanRepos(path, authorIdx > -1 ? args[authorIdx + 1] : undefined);
        if (!summaries.length) return die(`No git repos with your commits found at ${path}`);
        const store = new EventStore();
        const seen = store.importedGitRepos();
        const fresh = summaries.filter((s) => !seen.has(s.repo));
        const skipped = summaries.length - fresh.length;
        if (!fresh.length) {
          store.close();
          console.log(`All ${summaries.length} repo(s) already imported — nothing new.`);
          return;
        }
        console.error(`Found ${summaries.length} repo(s)${skipped ? ` (${skipped} already imported)` : ""} — importing ${fresh.map((s) => `${s.repo} (${s.commits} commits)`).join(", ")}`);
        const { events, batch } = gitEvents(fresh);
        store.append(events);
        store.rebuild();
        store.close();
        console.log(`Imported ${events.length} events from ${fresh.length} repo(s) (batch ${batch}).`);
        console.log(`Undo with: persnallyd forget --batch ${batch}`);
        return;
      }

      // Conversation imports: dedup by conversation_uuid so re-import only adds new chats.
      let parsed: ParsedExport;
      let file = "conversations.json";
      let parseNote = "";
      if (kind === "claude-code") {
        const root = path ?? DEFAULT_TRANSCRIPTS_DIR;
        file = root;
        const r = parseClaudeCodeTranscripts(root);
        if (!r.parsed.conversations.length) return die(`No usable sessions found at ${root}`);
        parsed = r.parsed;
        if (r.sessionsDropped) parseNote = ` (most recent ${r.parsed.conversations.length} of ${r.sessionsFound})`;
      } else if (kind === "claude") {
        if (!path) return die(usage);
        parsed = parseClaudeExport(path);
      } else if (kind === "chatgpt") {
        if (!path) return die(usage);
        parsed = parseChatGPTExport(path);
      } else {
        return die(`unknown import source "${kind}" — use claude, claude-code, chatgpt, or git`);
      }

      const store = new EventStore();
      const seen = store.importedConversationUuids(`import:${kind}`);
      const { parsed: toExtract, skipped, firstImport } = freshConversations(parsed, seen);
      if (!toExtract.conversations.length && !firstImport) {
        store.close();
        console.log(`Already up to date — all ${parsed.conversations.length} conversation(s) imported. Nothing new.`);
        return;
      }

      const engine = await chooseExtractor("extract");
      console.error(
        `Parsed ${parsed.conversations.length} conversation(s)${parseNote}${skipped ? ` — ${skipped} already imported` : ""}. ` +
        `Extracting ${toExtract.conversations.length} with ${engine.label}...`,
      );
      const { events, batch } = await (
        kind === "claude-code" ? extractClaudeCodeEvents(toExtract, engine.extract, engine.model, file)
        : kind === "claude" ? extractClaudeEvents(toExtract, engine.extract, engine.model)
        : extractChatGPTEvents(toExtract, engine.extract, engine.model)
      );
      store.append(events);
      store.rebuild();
      store.close();
      console.log(`Imported ${events.length} events from ${toExtract.conversations.length} conversation(s) (batch ${batch}).`);
      console.log(`Undo with: persnallyd forget --batch ${batch}`);
      return;
    }
    case "consolidate": {
      const engine = await chooseExtractor("extract").catch(() => null);
      const store = new EventStore();
      const r = await runConsolidation(store, engine);
      store.close();
      console.log(`Consolidation: ${r.newSignals} new signal(s) since last run, ${r.assertions} behavior assertion(s) added, profile ${r.profileRefreshed ? "refreshed" : "unchanged"}, ${r.stylePruned} style signal(s) pruned.`);
      return;
    }
    case "profile": {
      const engine = await chooseExtractor("profile");
      const store = new EventStore();
      console.error(`Synthesizing profile with ${engine.label}...`);
      const profile = await synthesizeProfile(store, engine.extract, engine.model);
      const scoped = await refreshScopedProfiles(store, engine.extract, engine.model);
      if (scoped.refreshed) console.error(`Also refreshed ${scoped.refreshed} scoped profile(s).`);
      store.close();
      console.log(renderProfile(profile));
      return;
    }
    case "ask": {
      const question = args.join(" ").trim();
      if (!question) return die('Usage: persnallyd ask "<question about the user>"');
      const engine = await chooseExtractor("extract").catch(() => null);
      const store = new EventStore();
      const r = await askUserModel(store, {
        question, asker: "cli", source: "cli", provenance: { kind: "local", surface: "cli" },
      }, engine);
      store.close();
      if (r.deferred) {
        console.log(`Deferred (${r.reason}): ${r.answer}`);
      } else {
        console.log(`${r.answer}\n\nconfidence ${r.confidence.toFixed(2)} · ${r.evidence_event_ids.length} evidence event(s) · review at http://127.0.0.1:${DEFAULT_PORT}`);
      }
      return;
    }
    case "correct": {
      // --about names the subject; the rest is the corrected truth.
      const aboutIdx = args.indexOf("--about");
      const subject = aboutIdx >= 0 ? (args[aboutIdx + 1] ?? "") : "";
      const rest = aboutIdx >= 0 ? [...args.slice(0, aboutIdx), ...args.slice(aboutIdx + 2)] : args;
      const correction = rest.join(" ").trim();
      if (!correction) return die('Usage: persnallyd correct "<what\'s actually true>" [--about <subject>]');
      const store = new EventStore();
      store.append([newEvent(
        "user.correction",
        "cli",
        { target_id: subject, action: "contradict", reason: correction },
        { kind: "local", surface: "cli" },
      )]);
      store.close();
      console.log(`Recorded${subject ? ` (re ${subject})` : ""}: "${correction}" — corrections are authoritative; the profile picks it up on the next synthesis.`);
      return;
    }
    case "search": {
      const query = args.join(" ").trim();
      if (!query) return die('Usage: persnallyd search "<topic>"');
      const store = new EventStore();
      const hits = searchContext(store, query);
      store.close();
      console.log(renderHits(hits, query));
      return;
    }
    case "voice": {
      // Deterministic, offline, re-runnable — refreshes the stylometry layer in place.
      const dir = args[0] || DEFAULT_TRANSCRIPTS_DIR;
      const store = new EventStore();
      const r = refreshVoice(store, dir, "cli");
      store.close();
      if (!r.signals) return die(`Not enough prose in ${dir} to fingerprint a voice yet.`);
      console.log(`Voice fingerprint refreshed from ${r.prompts} prompts.\n\n${r.pack}`);
      return;
    }
    case "show": {
      const store = new EventStore();
      if (args[0] === "profile") {
        const p = store.getProfile();
        console.log(p ? renderProfile(p) : "No profile yet. Run: persnallyd profile");
      } else if (args[0] === "events") {
        for (const e of store.query({ limit: 20 })) {
          console.log(`${e.ts}  ${e.type.padEnd(18)} ${e.source.padEnd(16)} ${summarize(e.payload)}`);
        }
      } else {
        const topics = store.topics(25);
        if (!topics.length) console.log("No topics yet. Run an import or connect an MCP client.");
        for (const t of topics) {
          console.log(`${t.weight.toFixed(2).padStart(6)}  ${t.topic} (${t.category}, ${t.signals} signals)`);
        }
      }
      store.close();
      return;
    }
    case "context": {
      // Serving path for the SessionStart hook: emit profile + interests for
      // injection AND record the read, so hook injections count toward the
      // context-reads metric exactly like the MCP persnally_context tool. `show`
      // stays side-effect-free so manual inspection never inflates the metric.
      const full = args.includes("--full");
      const hook = args.includes("--hook");
      const store = new EventStore();
      const profile = store.getProfile();
      const topics = store.topics(full ? 25 : 12);
      if (!profile && !topics.length) { store.close(); return; }
      const out: string[] = [];
      let items = topics.length;
      if (profile) {
        out.push("# About the user", profile.headline, "");
        const sections = full ? profile.sections : profile.sections.slice(0, 3);
        items += sections.length;
        for (const s of sections) out.push(`## ${s.title}`, s.body, "");
      }
      if (topics.length) {
        out.push("# Current interests (decay-weighted)");
        for (const t of topics) {
          out.push(`- ${t.topic} (${t.category}, ${t.dominant_intent}, weight ${t.weight.toFixed(2)})`);
        }
      }
      // Hook-only: put the loop tools in the default path. Soft instructions
      // are the only lever here — measured compliance is low (3% for track),
      // so keep them few, specific, and high-value. Not shown in plain `context`.
      if (hook) {
        out.push(
          "",
          "# Persnally — in this session",
          "Before interrupting the user with a question about their preferences, conventions, or how they'd decide, call persnally_ask first — it answers from their history or tells you to ask them.",
          "",
          "# Persnally — end-of-session",
          "When this session ends, call persnally_track with 1–3 topics it focused on (weight, intent, depth, category). Skip only if nothing substantial was discussed.",
        );
      }
      // Recording must never break the injection itself (mirrors MCP recordRead).
      try {
        store.append([newEvent(
          "context.read",
          "cli",
          { scope: full ? "full" : "brief", client_purpose: hook ? "session-start hook" : "cli context read", items },
          { kind: "local", surface: "cli" },
        )]);
      } catch (e) {
        console.error("persnally: context.read not recorded:", e instanceof Error ? e.message : e);
      }
      store.close();
      const rendered = out.join("\n");
      // --hook emits the SessionStart envelope itself, so the installed hook needs no jq.
      console.log(hook
        ? JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: rendered } })
        : rendered);
      return;
    }
    case "forget": {
      const store = new EventStore();
      if (args[0] === "--all") {
        store.forgetAll();
        console.log("All data deleted.");
      } else if (args[0] === "--batch" && args[1]) {
        console.log(`Deleted ${store.forgetBatch(args[1])} events from batch ${args[1]}.`);
      } else if (args[0] === "--style" && args[1] && args[2]) {
        store.forgetStyle(args[1], args[2]);
        console.log(`Forgot "${args[2]}" (${args[1]}) — won't be re-learned.`);
      } else if (args[0]) {
        console.log(`Deleted ${store.forgetTopic(args[0])} events for "${args[0]}".`);
      } else {
        die("usage: persnallyd forget <topic> | --all | --batch <id> | --style <dimension> <pattern>");
      }
      store.close();
      return;
    }
    case "status": {
      const store = new EventStore();
      const s = store.stats();
      store.close();
      console.log(`Store: ${DEFAULT_DB_PATH}`);
      console.log(`Events: ${s.total} (${s.first ?? "—"} → ${s.last ?? "—"})`);
      for (const [t, n] of Object.entries(s.byType)) console.log(`  ${t}: ${n}`);
      const pid = runningPid();
      console.log(pid ? `Daemon: running (pid ${pid})` : "Daemon: not running");
      console.log(`Autostart: ${autostartInstalled() ? "installed" : "not installed"}`);
      return;
    }
    case "export": {
      const store = new EventStore();
      const bundle = buildBundle(store, VERSION);
      store.close();
      const markdown = args.includes("--md");
      const body = markdown ? renderMarkdown(bundle) : JSON.stringify(bundle, null, 2);
      const outFlag = args.indexOf("--out");
      const out = outFlag >= 0 ? args[outFlag + 1] : undefined;
      if (outFlag >= 0 && !out) { console.error("--out needs a file path"); process.exit(1); }
      if (!out) { console.log(body); return; }
      writeFileSync(out, body.endsWith("\n") ? body : body + "\n", { mode: 0o600 });
      // stderr, so `persnallyd export --out f && cat f` stays clean to pipe.
      console.error(`Exported ${bundle.counts.events} events, ${bundle.counts.topics} topics → ${out}`);
      return;
    }
    case "activity": {
      const store = new EventStore();
      const a = store.activity();
      store.close();
      // --json is the retention-pulse snapshot: machine-readable, and reads the
      // store directly so collecting it never needs a daemon credential.
      if (args.includes("--json")) { console.log(JSON.stringify(a)); return; }
      if (!a.firstEventAt) { console.log("No activity yet — run an import or connect a client."); return; }
      const verdict = a.retainedWeek2 === null ? `in progress (day ${a.daysSinceFirstRead}/14 of reads)` : a.retainedWeek2 ? "active ✓" : "inactive ✗";
      console.log(`Onboarded ${a.daysSinceFirst}d ago · ${a.totalReads} context read(s) total`);
      console.log(`Reads: ${a.reads7d} this week · ${a.reads30d} this month`);
      console.log(`Active: ${a.activeDays7d}/7 days · ${a.activeDays14d}/14 days`);
      console.log(`Week-2 retention: ${verdict}`);
      console.log(`Last 14 days: ${sparkline(a.daily.map((d) => d.reads))}`);
      return;
    }
    case "dashboard": {
      const port = parsePort(args);
      if (args.includes("--rotate")) {
        rotateDashboardKey();
        console.log("New dashboard key issued — open browser sessions were signed out.");
      }
      if (!runningPid()) console.log("Note: the daemon isn't running — start it with `persnallyd start`.");
      announceDashboard(port);
      return;
    }
    case "start": {
      const existing = runningPid();
      if (existing) return die(`daemon already running (pid ${existing})`);
      const port = parsePort(args);
      const pid = await startDetached(process.argv[1]!, port);
      console.log(`persnallyd started (pid ${pid}).`);
      announceDashboard(port);
      console.log(`Logs: ${LOG_FILE}`);
      return;
    }
    case "stop": {
      if (autostartInstalled()) {
        console.error("Note: autostart is installed — the supervisor will respawn the daemon. To restart cleanly use `persnallyd restart`; to stop it for good use `persnallyd autostart --remove`.");
      }
      const pid = await stopDaemon();
      console.log(pid ? `Stopped daemon (pid ${pid}).` : "Daemon was not running.");
      return;
    }
    case "restart": {
      const port = parsePort(args);
      if (autostartInstalled()) {
        // The supervisor (launchd/systemd) owns the lifecycle — a plain stop just gets
        // respawned. Reload the job so it comes back on the current install (also heals
        // a drifted plist/unit path).
        const health = await reloadAutostart(process.argv[1]!, port);
        if (health) {
          console.log(`Restarted via ${process.platform === "linux" ? "systemd" : "launchd"} — daemon up on v${health.version}.`);
          announceDashboard(port);
        } else {
          console.log("Reloaded autostart; daemon is still coming up — check: persnallyd status");
        }
      } else {
        await stopDaemon();
        const pid = await startDetached(process.argv[1]!, port);
        console.log(`persnallyd restarted (pid ${pid}).`);
        announceDashboard(port);
      }
      return;
    }
    case "autostart": {
      if (args[0] === "--remove") {
        console.log(removeAutostart() ? "Autostart removed; daemon stopped." : "Autostart was not installed.");
        return;
      }
      // A running daemon holds the pidfile and would put the supervisor in a retry loop — hand over first.
      const stopped = await stopDaemon();
      if (stopped) console.log(`Stopped existing daemon (pid ${stopped}) — the supervisor takes over.`);
      const installed = installAutostart(process.argv[1]!, parsePort(args));
      console.log(`Autostart installed (${installed}). The daemon now runs at login and restarts if it exits.`);
      if (process.platform === "linux") {
        console.log("Tip: user services stop at logout — to keep the daemon running, enable lingering once: loginctl enable-linger $USER");
      }
      announceDashboard(parsePort(args), false); // the supervisor brings it up async — show the link, don't open a not-yet-ready page
      return;
    }
    case "serve": {
      const existing = runningPid();
      if (existing) return die(`daemon already running (pid ${existing}) — stop it first`);
      const port = parsePort(args);
      const store = new EventStore();
      const server = startDaemon(store, port);
      server.on("error", (e: NodeJS.ErrnoException) => {
        die(e.code === "EADDRINUSE" ? `port ${port} is already in use` : e.message);
      });
      writePidFile();
      const shutdown = () => {
        server.close();
        store.close();
        removePidFile();
        process.exit(0);
      };
      process.on("SIGTERM", shutdown);
      process.on("SIGINT", shutdown);
      // An always-on daemon must not die silently on a stray error. Log a
      // rejection and keep serving; on an uncaught exception the process state
      // is undefined — log and exit so the supervisor (launchd) restarts clean.
      process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));
      process.on("uncaughtException", (e) => { console.error("uncaughtException:", e); process.exit(1); });
      console.error(`persnallyd v${VERSION} listening on 127.0.0.1:${port}`);
      // Deliberately not the keyed URL: this line goes to the daemon log file.
      console.error("Dashboard: run `persnallyd dashboard` for an authenticated link");
      // Catch up on chats since the daemon last ran; the timer takes it from here.
      void autoImportNewSessions(store);
      return;
    }
    default:
      console.log(USAGE);
      process.exitCode = cmd ? 1 : 0;
  }
}

function sparkline(values: number[]): string {
  const blocks = "▁▂▃▄▅▆▇█";
  const max = Math.max(...values, 1);
  return values.map((v) => (v === 0 ? "·" : blocks[Math.min(blocks.length - 1, Math.floor((v / max) * (blocks.length - 1)))])).join("");
}

function summarize(payload: Record<string, unknown>): string {
  const s = JSON.stringify(payload);
  return s.length > 80 ? s.slice(0, 77) + "..." : s;
}

/**
 * Print an authenticated dashboard link and, when run interactively on macOS,
 * open it. The key rides in the URL exactly once: the daemon swaps it for a
 * session cookie and redirects, so it never persists in the browser.
 */
function announceDashboard(port: number, open = true): void {
  const url = `http://127.0.0.1:${port}/?k=${dashboardKey()}`;
  console.log(`Dashboard: ${url}`);
  if (open && process.platform === "darwin" && process.stdout.isTTY) {
    try { execFileSync("open", [url]); } catch { /* non-fatal — the link is printed above */ }
  }
}

function die(msg: string): void {
  console.error(msg);
  process.exit(1);
}

main().catch((e) => die(e instanceof Error ? e.message : String(e)));
