/**
 * "Every AI" used to mean three Anthropic-shaped clients. These five agree on
 * stdio and disagree on everything else, so each config shape is asserted
 * against the vendor's documented format — writing a plausible-but-wrong shape
 * is worse than not supporting the client, because it fails inside someone
 * else's editor with no error we ever see.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "connect-clients-"));
const store = mkdtempSync(join(tmpdir(), "connect-clients-store-"));
after(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(store, { recursive: true, force: true });
});

// connect.ts reads homedir() at call time, so the env must be set before import.
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.PERSNALLY_DIR = store;

let connectClient: typeof import("../src/connect.js").connectClient;
let CLIENTS: typeof import("../src/connect.js").CLIENTS;
let upsertCodexToml: typeof import("../src/connect.js").upsertCodexToml;

before(async () => {
  process.env.PERSNALLY_MCP = join(store, "index.js");
  writeFileSync(process.env.PERSNALLY_MCP, "// stub server\n");
  ({ connectClient, CLIENTS, upsertCodexToml } = await import("../src/connect.js"));
});

const read = (...p: string[]) => JSON.parse(readFileSync(join(home, ...p), "utf-8"));

describe("a client that isn't installed is skipped, not created", () => {
  test("connect returns null and writes nothing", () => {
    for (const c of ["codex", "gemini-cli", "windsurf", "zed", "vscode"] as const) {
      assert.equal(connectClient(c), null, `${c} must not be configured when absent`);
    }
  });
});

describe("each client gets the shape its own docs specify", () => {
  before(() => {
    for (const dir of [[".codex"], [".gemini"], [".codeium", "windsurf"], [".config", "zed"]]) {
      mkdirSync(join(home, ...dir), { recursive: true });
    }
    mkdirSync(join(home, "Library", "Application Support", "Code", "User"), { recursive: true });
    mkdirSync(join(home, ".config", "Code", "User"), { recursive: true });
  });

  test("Gemini CLI and Windsurf use mcpServers { command, args, env }", () => {
    connectClient("gemini-cli");
    connectClient("windsurf");

    for (const entry of [
      read(".gemini", "settings.json").mcpServers.persnally,
      read(".codeium", "windsurf", "mcp_config.json").mcpServers.persnally,
    ]) {
      assert.equal(entry.command, "node");
      assert.ok(entry.args[0].endsWith("index.js"));
      assert.ok(entry.env.PERSNALLY_CLIENT_TOKEN, "the daemon refuses a client with no token");
    }
    assert.equal(read(".gemini", "settings.json").mcpServers.persnally.env.PERSNALLY_CLIENT, "gemini-cli");
  });

  test("Zed uses context_servers with command as an object, not a string", () => {
    connectClient("zed");
    const entry = read(".config", "zed", "settings.json").context_servers.persnally;

    assert.equal(typeof entry.command, "object", "Zed nests path/args/env under command");
    assert.equal(entry.command.path, "node");
    assert.ok(entry.command.args[0].endsWith("index.js"));
    assert.equal(entry.command.env.PERSNALLY_CLIENT, "zed");
    assert.equal(entry.source, "custom");
  });

  test("VS Code uses servers with an explicit stdio type", () => {
    connectClient("vscode");
    const file = process.platform === "darwin"
      ? [ "Library", "Application Support", "Code", "User", "mcp.json"]
      : [".config", "Code", "User", "mcp.json"];
    const entry = read(...file).servers.persnally;

    assert.equal(entry.type, "stdio", "VS Code requires type on every server");
    assert.equal(entry.command, "node");
    assert.ok(entry.args[0].endsWith("index.js"));
    assert.equal(entry.env.PERSNALLY_CLIENT, "vscode");
  });

  test("Codex gets TOML, not JSON", () => {
    connectClient("codex");
    const toml = readFileSync(join(home, ".codex", "config.toml"), "utf-8");

    assert.match(toml, /^\[mcp_servers\.persnally\]$/m);
    assert.match(toml, /command = "node"/);
    assert.match(toml, /^\[mcp_servers\.persnally\.env\]$/m);
    assert.match(toml, /PERSNALLY_CLIENT = "codex"/);
    assert.doesNotMatch(toml, /^\{/, "a JSON body here would be silently ignored by Codex");
  });
});

describe("connecting twice does not duplicate or drift", () => {
  test("JSON clients keep exactly one entry and rotate the token", () => {
    const first = read(".gemini", "settings.json").mcpServers.persnally.env.PERSNALLY_CLIENT_TOKEN;
    connectClient("gemini-cli");
    const cfg = read(".gemini", "settings.json");

    assert.equal(Object.keys(cfg.mcpServers).filter((k) => k === "persnally").length, 1);
    assert.notEqual(cfg.mcpServers.persnally.env.PERSNALLY_CLIENT_TOKEN, first, "connect rotates identity");
  });

  test("Codex keeps one table across repeated connects", () => {
    connectClient("codex");
    connectClient("codex");
    const toml = readFileSync(join(home, ".codex", "config.toml"), "utf-8");
    assert.equal(toml.match(/^\[mcp_servers\.persnally\]$/gm)?.length, 1);
    assert.equal(toml.match(/^\[mcp_servers\.persnally\.env\]$/gm)?.length, 1);
  });
});

describe("existing config survives — this writes into files people already own", () => {
  test("other MCP servers and unrelated settings are preserved", () => {
    writeFileSync(join(home, ".gemini", "settings.json"), JSON.stringify({
      theme: "dark",
      mcpServers: { other: { command: "x" } },
    }));
    connectClient("gemini-cli");
    const cfg = read(".gemini", "settings.json");

    assert.equal(cfg.theme, "dark");
    assert.equal(cfg.mcpServers.other.command, "x");
    assert.ok(cfg.mcpServers.persnally);
  });

  test("Zed's other settings and context servers are preserved", () => {
    writeFileSync(join(home, ".config", "zed", "settings.json"), JSON.stringify({
      vim_mode: true,
      context_servers: { other: { command: { path: "x", args: [] } } },
    }));
    connectClient("zed");
    const cfg = read(".config", "zed", "settings.json");

    assert.equal(cfg.vim_mode, true);
    assert.equal(cfg.context_servers.other.command.path, "x");
    assert.ok(cfg.context_servers.persnally);
  });

  test("a JSON config we cannot parse is reported, never overwritten", () => {
    const file = join(home, ".gemini", "settings.json");
    writeFileSync(file, "{ not json");
    assert.throws(() => connectClient("gemini-cli"), /not valid JSON/);
    assert.equal(readFileSync(file, "utf-8"), "{ not json", "the user's file is left exactly as found");
  });
});

describe("the Codex TOML splice preserves everything it does not own", () => {
  const BLOCK = '[mcp_servers.persnally]\ncommand = "node"';

  test("unrelated tables, keys and comments survive verbatim", () => {
    const existing = [
      "# my codex config",
      'model = "o3"',
      "",
      "[mcp_servers.github]",
      'command = "npx"',
      'args = ["-y", "server-github"]',
      "",
    ].join("\n");

    const out = upsertCodexToml(existing, BLOCK);
    assert.match(out, /# my codex config/);
    assert.match(out, /model = "o3"/);
    assert.match(out, /\[mcp_servers\.github\]/);
    assert.match(out, /args = \["-y", "server-github"\]/);
    assert.match(out, /\[mcp_servers\.persnally\]/);
  });

  test("an existing persnally table is replaced, including its env subtable", () => {
    const existing = [
      "[mcp_servers.persnally]",
      'command = "old"',
      "",
      "[mcp_servers.persnally.env]",
      'PERSNALLY_CLIENT_TOKEN = "stale"',
      "",
      "[mcp_servers.other]",
      'command = "keep"',
    ].join("\n");

    const out = upsertCodexToml(existing, BLOCK);
    assert.doesNotMatch(out, /command = "old"/);
    assert.doesNotMatch(out, /stale/, "a rotated token must not leave the previous one behind");
    assert.match(out, /command = "keep"/, "the table after ours must survive");
    assert.equal(out.match(/\[mcp_servers\.persnally\]/g)?.length, 1);
  });

  test("an empty file yields just our block, with no leading blank lines", () => {
    assert.equal(upsertCodexToml("", BLOCK), BLOCK + "\n");
  });

  test("a table named similarly is not mistaken for ours", () => {
    const existing = '[mcp_servers.persnally_backup]\ncommand = "keep"';
    const out = upsertCodexToml(existing, BLOCK);
    assert.match(out, /persnally_backup/);
    assert.match(out, /command = "keep"/);
  });
});

describe("the client list is what the docs promise", () => {
  test("all eight clients are addressable", () => {
    assert.deepEqual([...CLIENTS].sort(), [
      "claude-code", "claude-desktop", "codex", "cursor", "gemini-cli", "vscode", "windsurf", "zed",
    ]);
  });
});
