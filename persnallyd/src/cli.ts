#!/usr/bin/env node
/**
 * persnallyd CLI — the developer's window into the daemon.
 * Merges into the `persnally` npm identity at Phase 1 launch.
 */

import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { applyApiKey, configPath, loadConfig, saveConfig } from "./config.js";
import { CLIENTS, connectAll, connectClient, installClaudeCodeHook, type Client } from "./connect.js";
import {
  installedHook, newestSession, render as renderChecks, resolveBin, runChecks, worst,
  type Facts,
} from "./doctor.js";
import { runConsolidation } from "./consolidate.js";
import { buildBundle, renderMarkdown } from "./export.js";
import { chooseExtractor, ollamaTags, pullOllamaModel, RECOMMENDED_LOCAL_MODEL, type ChosenExtractor } from "./llm.js";
import { CATEGORIES, clearScope, dashboardKey, loadScopes, rotateDashboardKey, setScope, type Category } from "./permissions.js";
import {
  alreadyImported, DENSITY_QUESTIONS, eventsFromAnswers, importAllSources, importedMemoryHashes,
  isThin, markImported, markMemoryImported,
} from "./setup.js";
import { autoImportNewSessions, DEFAULT_PORT, startDaemon, VERSION } from "./daemon.js";
import { extractChatGPTEvents, parseChatGPTExport } from "./importers/chatgpt.js";
import { DEFAULT_CODEX_SESSIONS_DIR, extractCodexEvents, parseCodexTranscripts } from "./importers/codex.js";
import { defaultCursorDb, extractCursorEvents, parseCursorHistory } from "./importers/cursor.js";
import { extractClaudeEvents, parseClaudeExport } from "./importers/claude.js";
import {
  DEFAULT_TRANSCRIPTS_DIR, extractClaudeCodeEvents, parseClaudeCodeTranscripts,
  projectKey,
} from "./importers/claude-code.js";
import { gitEvents, scanRepos } from "./importers/git.js";
import { EXTRACTOR_VERSION, freshConversations, memorySnapshotHash, type ParsedExport } from "./importers/extract.js";
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
import { buildContextPack, recordContextRead } from "./context-pack.js";

/** One spelling in everything the user is told to retype. `persnallyd` is the
    same file (both bins point at cli.js); mixing them mid-flow reads as two tools. */
const BIN = "persnally";

const USAGE = `${BIN} ${VERSION} — so every AI finally knows you

Usage:
  persnally setup [--yes] [--engine ollama|anthropic|none]
                                   One command: find exports, import, synthesize, connect, open
                                   --yes runs unattended (an agent can drive it); --engine forces the extractor
  persnally connect [client|--all] [--scope cats]  Add Persnally to any of 8 clients, or --all (optionally scope it inline)
  persnally scope <client> <categories|--clear>   Limit what a client can read (e.g. scope cursor technology,career)
  persnally scope                  Show all client scopes
  persnally init                   Create the local store (~/.persnally/persnally.db)
  persnally import claude <dir>    Import a Claude data export (needs ANTHROPIC_API_KEY)
  persnally import claude-code [dir]  Import Claude Code session transcripts (default ~/.claude/projects)
  persnally import chatgpt <path>  Import a ChatGPT export dir or conversations.json (needs ANTHROPIC_API_KEY)
  persnally import cursor [db]     Import Cursor chat history (default: Cursor's own state.vscdb, needs ANTHROPIC_API_KEY)
  persnally import codex [dir]     Import Codex session transcripts (default ~/.codex/sessions, needs ANTHROPIC_API_KEY)
  persnally import git <path> [--author <email>]   Import repo activity (offline, no LLM); path = repo or folder of repos
  persnally import <source> <path> --reextract   Re-extract already-imported conversations with the current extractor
  persnally profile                Synthesize your profile from the store
  persnally ask "<question>"       Ask your model a question the way an agent would (answers or defers)
  persnally search "<topic>"       What Persnally knows about a specific subject (offline, no LLM)
  persnally correct "<truth>" [--about <subject>]   Correct something it believes about you (authoritative)
  persnally voice                  Refresh your voice fingerprint from Claude Code transcripts (offline, no LLM)
  persnally consolidate            Reflect now: refresh decay, add behavior patterns, re-synthesize
  persnally show [topics|events|profile]   Show topics (default), recent events, or the profile
  persnally context [--full]       Emit profile + interests for AI injection (records a context read)
  persnally export [--md] [--out <file>]   Take everything with you (JSON by default; --md for a readable portrait)
  persnally forget <topic>         Hard-delete a topic and everything derived from it
  persnally forget --style <dimension> <pattern>   Forget a "how you write" pattern for good
  persnally forget --all           Delete all data
  persnally forget --batch <id>    Undo one import batch
  persnally dashboard [--rotate]   Open the local dashboard (--rotate signs out open browser sessions)
  persnally status                 Store stats and daemon health
  persnally doctor [--json]        Check the install end to end (bins, daemon, capture, hook)
  persnally activity [--json]      Context-read engagement over time (retention pulse)
  persnally start [--port N]       Start the daemon in the background
  persnally stop                   Stop the background daemon
  persnally restart                Restart the daemon (correctly handles autostart/launchd)
  persnally serve [--port N]       Run the daemon in the foreground (127.0.0.1:${DEFAULT_PORT})
  persnally autostart [--remove]   Start the daemon at login and keep it alive (macOS launchd · Linux systemd)
  persnally config set-key [key]   Store the Anthropic API key (owner-only file); omit the key to read it
                                   from stdin, keeping it out of argv and shell history
  persnally config                 Show config (key masked)
`;

/** Reads piped input whole. Used so a secret need never appear in argv. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf-8").trim();
}

function parsePort(args: string[]): number {
  const i = args.indexOf("--port");
  return i > -1 && args[i + 1] ? Number(args[i + 1]) : DEFAULT_PORT;
}

/** Reachable daemon's version, or null. Never throws — callers are diagnostics. */
async function daemonVersion(port: number): Promise<{ version: string } | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!r.ok) return null;
    return (await r.json()) as { version: string };
  } catch {
    return null;
  }
}

async function gatherFacts(port: number): Promise<Facts> {
  const store = new EventStore();
  const lastReadAt = store.activity().lastReadAt;
  store.close();

  const health = await daemonVersion(port);
  // An engine exists if a key is configured or Ollama has any model. Mirrors
  // chooseExtractor's preference order without running an extraction.
  const hasEngine = Boolean(process.env.ANTHROPIC_API_KEY || loadConfig().anthropic_api_key)
    || ((await ollamaTags()) ?? []).length > 0;

  return {
    cliVersion: VERSION,
    daemonVersion: health?.version ?? null,
    daemonPid: runningPid(),
    autostartInstalled: autostartInstalled(),
    bins: ["persnally", "persnallyd", "persnally-mcp"].map((b) => resolveBin(b)),
    lastReadAt,
    newestSessionAt: newestSession(DEFAULT_TRANSCRIPTS_DIR),
    hookCommand: installedHook(),
    hasEngine,
    now: Date.now(),
    platform: process.platform,
  };
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  // Asking for the version or the help text is a successful request, not a
  // usage error — COLD_DEMO.md's pre-flight runs `--version` and a non-zero
  // exit reads as a broken install.
  if (cmd === "--version" || cmd === "-v") { console.log(VERSION); return; }
  if (cmd === "--help" || cmd === "-h") { console.log(USAGE); return; }
  applyApiKey();
  switch (cmd) {
    case "setup": {
      const port = parsePort(args);
      console.log("Persnally setup — so every AI finally knows you.\n");

      // 1. Extraction engine. Optional (git works without one) but everything
      //    that makes the portrait worth reading needs it, so try to get one
      //    rather than silently degrading to a git-only mirror.
      const engineOpts = parseEngineOptions(args);
      // "none" means no engine at all, so it can never be a forced *choice*.
      const forcedEngine = engineOpts.engine === "none" ? undefined : engineOpts.engine ?? undefined;
      const engine = await resolveSetupEngine(engineOpts);

      // 2. Daemon
      if (!runningPid()) {
        await startDetached(process.argv[1]!, port);
        console.log(`✓ Daemon started (http://127.0.0.1:${port})`);
      } else {
        console.log("✓ Daemon already running");
      }

      // 3. Conversation sources: Claude/ChatGPT exports on disk + Claude Code
      //    transcripts. Same path the dashboard's POST /import runs, so an
      //    engine configured later picks up exactly what was skipped here.
      const store = new EventStore();
      let imported = 0;
      const conv = await importAllSources(store, engine, {
        onProgress: (label) => console.log(`→ ${label}`),
        onTick: (done, total) => {
          // \r keeps a multi-minute extraction to one live line; the newline
          // below closes it so the next log doesn't overwrite the final count.
          if (process.stdout.isTTY) process.stdout.write(`\r  extracting ${done}/${total}…   `);
          else if (done === total) console.log(`  extracted ${done}/${total}`);
        },
      });
      if (process.stdout.isTTY && conv.imported.length) process.stdout.write("\n");
      imported += conv.events;
      if (conv.imported.length) console.log(`  ✓ ${conv.events} events from ${conv.imported.length} source(s)`);

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
        const profileEngine = await chooseExtractor("profile", forcedEngine);
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

      // Never report plain success over history we silently passed over: the
      // user has an export sitting on disk and no way to know it was skipped.
      if (conv.skipped.length) {
        console.log(`\n⚠ Set up an AI engine to finish — ${conv.skipped.length} source(s) not imported yet:`);
        for (const s of conv.skipped) console.log(`    · ${s}`);
        console.log("  Your portrait is built from git alone until then. To finish:");
        console.log("    · open the dashboard below and set up local AI in one click (free, private), or");
        console.log(`    · ${BIN} config set-key <sk-ant-…>`);
        console.log(`  then re-run: ${BIN} setup`);
      } else {
        console.log(`\nDone${imported ? ` — ${imported} events imported` : ""}.`);
      }
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
      if (!spec) return die("usage: persnally scope <client> <cat1,cat2|--clear>");
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
        // A key passed as an argument is visible in `ps` and lands in shell
        // history — worse when an agent composes the command, since it then
        // also lands in a transcript. Reading stdin gives callers a way to
        // supply it that leaves no such trace.
        const key = args[1] ?? (process.stdin.isTTY ? "" : await readStdin());
        if (!key.startsWith("sk-ant-")) {
          return die("expected an Anthropic key (sk-ant-...)\n"
            + "  Avoid putting it in the command line — pipe it instead:\n"
            + `    printf '%s' "$ANTHROPIC_API_KEY" | ${BIN} config set-key`);
        }
        saveConfig({ anthropic_api_key: key });
        console.log(`Key saved to ${configPath()} (mode 600). Restart the daemon to apply: persnally stop`);
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
      const usage = "usage: persnally import claude|claude-code|chatgpt|cursor|codex|git <path> [--reextract]";
      if (!kind) return die(usage);
      // Re-run extraction over conversations already on file. The store keeps
      // no raw text (structured signals only), so this reads the source again —
      // which is why it takes the same path argument as a first import.
      const reextract = args.includes("--reextract");

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
        console.log(`Undo with: persnally forget --batch ${batch}`);
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
      } else if (kind === "cursor") {
        const db = path ?? defaultCursorDb();
        file = db;
        const r = parseCursorHistory(db);
        if (!r.parsed.conversations.length) return die(`No usable Cursor chats found at ${db}`);
        parsed = r.parsed;
        if (r.composersDropped) parseNote = ` (most recent ${r.parsed.conversations.length} of ${r.composersFound})`;
      } else if (kind === "codex") {
        const dir = path ?? DEFAULT_CODEX_SESSIONS_DIR;
        file = dir;
        const r = parseCodexTranscripts(dir);
        if (!r.parsed.conversations.length) return die(`No usable Codex sessions found at ${dir}`);
        parsed = r.parsed;
        if (r.sessionsDropped) parseNote = ` (most recent ${r.parsed.conversations.length} of ${r.sessionsFound})`;
      } else {
        return die(`unknown import source "${kind}" — use claude, claude-code, chatgpt, cursor, codex, or git`);
      }

      const store = new EventStore();
      const seen = store.importedConversationUuids(`import:${kind}`);
      // --reextract deliberately bypasses the uuid dedup: every conversation is
      // extracted again with the current pipeline, and the prior events for
      // those conversations are dropped just before the new ones land, so a
      // re-run replaces rather than doubles.
      const { parsed: toExtract, skipped, firstImport, memoryHash } = reextract
        ? { parsed, skipped: 0, firstImport: true, memoryHash: memorySnapshotHash(parsed) }
        : freshConversations(parsed, seen, importedMemoryHashes());
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
        : kind === "cursor" ? extractCursorEvents(toExtract, engine.extract, engine.model, file)
        : kind === "codex" ? extractCodexEvents(toExtract, engine.extract, engine.model, file)
        : extractChatGPTEvents(toExtract, engine.extract, engine.model)
      );
      // Replace, don't accumulate — and only after extraction succeeded, so a
      // failed re-run leaves the existing signals intact rather than deleting
      // them and having nothing to put back.
      let replaced = 0;
      if (reextract) {
        replaced = store.forgetConversations(`import:${kind}`,
          new Set(toExtract.conversations.map((c) => c.uuid).filter(Boolean)));
      }
      store.append(events);
      store.rebuild();
      store.close();
      markMemoryImported(memoryHash); // only after the extraction that consumed it succeeded
      console.log(
        `Imported ${events.length} events from ${toExtract.conversations.length} conversation(s) (batch ${batch}).` +
        (reextract ? ` Replaced ${replaced} event(s) from earlier extractions.` : ""),
      );
      console.log(`Undo with: persnally forget --batch ${batch}`);
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
      if (!question) return die('Usage: persnally ask "<question about the user>"');
      const engine = await chooseExtractor("extract").catch(() => null);
      const store = new EventStore();
      const r = await askUserModel(store, {
        question, asker: "cli", source: "cli", provenance: { kind: "local", surface: "cli" },
        project: projectKey(process.cwd()),
      }, engine);
      store.close();
      if (r.deferred) {
        console.log(`Deferred (${r.reason}): ${r.answer}`);
      } else {
        console.log(`${r.answer}\n\nconfidence ${r.confidence.toFixed(2)} · ${r.evidence_event_ids.length} evidence event(s) · review at ${dashboardUrl(DEFAULT_PORT)}`);
      }
      return;
    }
    case "correct": {
      // --about names the subject; the rest is the corrected truth.
      const aboutIdx = args.indexOf("--about");
      const subject = aboutIdx >= 0 ? (args[aboutIdx + 1] ?? "") : "";
      const rest = aboutIdx >= 0 ? [...args.slice(0, aboutIdx), ...args.slice(aboutIdx + 2)] : args;
      const correction = rest.join(" ").trim();
      if (!correction) return die('Usage: persnally correct "<what\'s actually true>" [--about <subject>]');
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
      if (!query) return die('Usage: persnally search "<topic>"');
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
      console.log(`Voice fingerprint refreshed from ${r.prompts} prompts${
        r.projects ? `, plus tool conventions from ${r.projects} project${r.projects === 1 ? "" : "s"}` : ""
      }.\n\n${r.pack}`);
      return;
    }
    case "show": {
      const store = new EventStore();
      if (args[0] === "profile") {
        const p = store.getProfile();
        console.log(p ? renderProfile(p) : "No profile yet. Run: persnally profile");
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
      // Serving path for the SessionStart hook and for manual inspection. Both
      // render and record through context-pack.ts — the single door — while
      // `show` stays side-effect-free so inspection never inflates the metric.
      const full = args.includes("--full");
      const hook = args.includes("--hook");
      // A hook read is consumed by the client whose session it is injected into,
      // not by the CLI that rendered it. Defaults to claude-code because that is
      // the only client the installer targets, so hooks installed before this
      // change attribute correctly without being reinstalled.
      const hookClient = (args.find((a) => a.startsWith("--client="))?.slice(9) || "claude-code")
        .toLowerCase().replace(/[^a-z0-9._-]/g, "-");
      const store = new EventStore();
      // The hook runs inside the workspace it injects into, so cwd is the
      // project — no protocol needed to ask for it.
      const pack = buildContextPack(store, { detail: full ? "full" : "brief", project: projectKey(process.cwd()) });
      if (!pack.text) { store.close(); return; }

      const out = [pack.text];
      // Hook-only: put the loop tools in the default path. Soft instructions are
      // the only lever here — measured compliance is low (3% for track) — so keep
      // them few, specific and high-value.
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
      recordContextRead(store, {
        surface: hook ? "hook" : "cli",
        client: hook ? hookClient : undefined,
        scope: full ? "full" : "brief",
        purpose: hook ? "session-start hook" : "cli context read",
        items: pack.items,
      });
      store.close();

      const body = out.join("\n");
      console.log(hook
        ? JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: body } })
        : body);
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
        die("usage: persnally forget <topic> | --all | --batch <id> | --style <dimension> <pattern>");
      }
      store.close();
      return;
    }
    case "doctor": {
      const checks = runChecks(await gatherFacts(parsePort(args)));
      if (args.includes("--json")) {
        console.log(JSON.stringify({ level: worst(checks), checks }, null, 2));
      } else {
        console.log(renderChecks(checks));
      }
      // Non-zero on failure so a wrapper script or agent can branch on it.
      if (worst(checks) === "fail") process.exitCode = 1;
      return;
    }

    case "status": {
      const store2 = new EventStore();
      const s = store2.stats();
      console.log(`Store: ${DEFAULT_DB_PATH}`);
      console.log(`Events: ${s.total} (${s.first ?? "—"} → ${s.last ?? "—"})`);
      for (const [t, n] of Object.entries(s.byType)) console.log(`  ${t}: ${n}`);
      const pid = runningPid();
      console.log(pid ? `Daemon: running (pid ${pid})` : "Daemon: not running");
      console.log(`Autostart: ${autostartInstalled() ? "installed" : "not installed"}`);

      // Imports made by an older pipeline can be re-run for better signals —
      // the whole point of stamping a version is that the user gets told.
      const stale = new Map<string, number>();
      for (const importer of ["claude", "claude-code", "chatgpt", "cursor", "codex"]) {
        const old = store2.importBatchVersions(importer)
          .filter((b) => (b.version ?? 0) < EXTRACTOR_VERSION);
        if (old.length) stale.set(importer, old.reduce((n, b) => n + b.events, 0));
      }
      store2.close();
      if (stale.size) {
        console.log(`\nExtractor: v${EXTRACTOR_VERSION} — some imports predate it:`);
        for (const [importer, events] of stale) {
          console.log(`  ${importer}: ~${events} event(s) from an older extractor`);
        }
        console.log(`  Re-run with the current extractor: ${BIN} import <source> <path> --reextract`);
      }

      // Surface breakage where people already look. A silent install is the
      // whole risk: nobody runs a diagnostic they have no reason to suspect.
      const problems = runChecks(await gatherFacts(parsePort(args))).filter((c) => c.level !== "ok");
      if (problems.length) {
        console.log("");
        for (const p of problems) console.log(`${p.level === "fail" ? "✗" : "!"} ${p.title}`);
        console.log(`  Details: ${BIN} doctor`);
      }
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
      if (!runningPid()) console.log("Note: the daemon isn't running — start it with `persnally start`.");
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
        console.error("Note: autostart is installed — the supervisor will respawn the daemon. To restart cleanly use `persnally restart`; to stop it for good use `persnally autostart --remove`.");
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
          console.log("Reloaded autostart; daemon is still coming up — check: persnally status");
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
      console.error(`Dashboard: run \`${BIN} dashboard\` for an authenticated link`);
      // Catch up on chats since the daemon last ran; the timer takes it from here.
      void autoImportNewSessions(store);
      return;
    }
    default:
      console.log(USAGE);
      process.exitCode = cmd ? 1 : 0;
  }
}

/**
 * The engine `setup` runs on. Beyond chooseExtractor's normal resolution: when
 * Ollama is running with no model pulled, offer the download here instead of
 * only in the dashboard. Without an engine the entire conversation import is
 * skipped, and a terminal user shouldn't have to find the dashboard to learn
 * that — this is the one failure case setup can actually fix in place.
 */
/** How setup should obtain an extraction engine without a human present. */
export interface EngineOptions {
  /** Accept the model download without asking — the agent-driven path. */
  yes: boolean;
  /** Force a specific engine; null means the usual preference order. */
  engine: "ollama" | "anthropic" | "none" | null;
}

export function parseEngineOptions(args: string[]): EngineOptions {
  const occurrences = args.filter((a) => a === "--engine").length;
  if (occurrences > 1) throw new Error("--engine given more than once");
  const i = args.indexOf("--engine");
  let engine: EngineOptions["engine"] = null;
  if (i > -1) {
    // A present-but-malformed flag must fail, not fall back to the default:
    // an agent whose command was truncated would otherwise get a different
    // engine than it asked for and no indication anything went wrong.
    const raw = args[i + 1];
    if (!raw || !["ollama", "anthropic", "none"].includes(raw)) {
      throw new Error(`--engine must be ollama, anthropic or none (got ${raw ? `"${raw}"` : "nothing"})`);
    }
    engine = raw as EngineOptions["engine"];
  }
  return { yes: args.includes("--yes") || args.includes("-y"), engine };
}

async function resolveSetupEngine(opts: EngineOptions): Promise<ChosenExtractor | null> {
  if (opts.engine === "none") {
    console.log("· Engine skipped (--engine none) — git and voice import offline; conversations are left for later.");
    return null;
  }

  // A forced engine is resolved directly and never falls back — see
  // chooseExtractor. Falling back here would hand `--engine ollama` the
  // Anthropic extractor whenever a key happened to be set.
  if (opts.engine) {
    try {
      const forced = await chooseExtractor("extract", opts.engine);
      console.log(`✓ Extraction engine: ${forced.label}`);
      return forced;
    } catch (e) {
      // Ollama running with no model is recoverable below; anything else is not.
      if (opts.engine === "anthropic" || (await ollamaTags()) === null) {
        console.log(`· ${e instanceof Error ? e.message : String(e)}`);
        return null;
      }
    }
  }

  const found = opts.engine ? null : await chooseExtractor("extract").catch(() => null);
  if (found) {
    console.log(`✓ Extraction engine: ${found.label}`);
    return found;
  }

  const tags = await ollamaTags();
  if (tags === null) {
    console.log("· No extraction engine — no API key, and Ollama isn't running.");
    console.log(`    Local & free: install from https://ollama.com/download, then re-run \`${BIN} setup\``);
    console.log(`    Or use a key: ${BIN} config set-key <sk-ant-…>`);
    return null;
  }

  const pull = `ollama pull ${RECOMMENDED_LOCAL_MODEL}`;
  // An agent running this has no terminal to answer in, so consent has to be
  // expressible as a flag — otherwise the only non-interactive outcome is the
  // degraded one.
  const preapproved = opts.yes || opts.engine === "ollama";
  if (!preapproved && !process.stdin.isTTY) {
    console.log(`· Ollama is running but has no model. Run \`${pull}\`, then re-run \`${BIN} setup\`.`);
    console.log(`    Or let setup fetch it: ${BIN} setup --yes`);
    return null;
  }

  if (!preapproved) {
    const { createInterface } = await import("node:readline/promises");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const reply = (await rl.question(
      `· Ollama is running but has no model yet.\n  Download ${RECOMMENDED_LOCAL_MODEL} now (~2GB, free, never leaves this machine)? [Y/n] `,
    )).trim().toLowerCase();
    rl.close();
    if (reply && !reply.startsWith("y")) {
      console.log(`  Skipped — conversation imports need a model. Re-run \`${BIN} setup\` after \`${pull}\`.`);
      return null;
    }
  } else {
    console.log(`· Fetching ${RECOMMENDED_LOCAL_MODEL} (~2GB, free, never leaves this machine)…`);
  }

  try {
    let shown = -1;
    await pullOllamaModel(RECOMMENDED_LOCAL_MODEL, ({ percent }) => {
      // One redraw per 10%: a multi-GB download would otherwise emit thousands
      // of lines into a piped log.
      const decile = Math.floor(percent / 10);
      if (decile <= shown) return;
      shown = decile;
      process.stdout.write(`\r  downloading ${RECOMMENDED_LOCAL_MODEL}… ${percent}%   `);
    });
    process.stdout.write("\n");
  } catch (e) {
    console.log(`\n  Download failed (${e instanceof Error ? e.message : String(e)}) — continuing without an engine.`);
    return null;
  }

  const engine = await chooseExtractor("extract", opts.engine ?? undefined).catch(() => null);
  if (engine) console.log(`✓ Extraction engine: ${engine.label}`);
  return engine;
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
function dashboardUrl(port: number): string {
  return `http://127.0.0.1:${port}/?k=${dashboardKey()}`;
}

function announceDashboard(port: number, open = true): void {
  const url = dashboardUrl(port);
  console.log(`Dashboard: ${url}`);
  if (!open || !process.stdout.isTTY) return;
  // Linux and Windows users had to copy-paste; the opener differs per platform.
  const [cmd, ...pre] = process.platform === "darwin" ? ["open"]
    : process.platform === "win32" ? ["cmd", "/c", "start", ""]
    : ["xdg-open"];
  try { execFileSync(cmd, [...pre, url], { stdio: "ignore" }); }
  catch { /* non-fatal — the link is printed above */ }
}

function die(msg: string): void {
  console.error(msg);
  process.exit(1);
}

main().catch((e) => die(e instanceof Error ? e.message : String(e)));
