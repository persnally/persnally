import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const home = mkdtempSync(join(tmpdir(), "connect-test-"));
const CLI = join(import.meta.dirname, "..", "src", "cli.js");

// Hermetic MCP target: the test must not depend on the MCP server being built (build/ is gitignored).
const fakeMcp = join(home, "fake-mcp", "index.js");
mkdirSync(join(home, "fake-mcp"));
writeFileSync(fakeMcp, "// stub\n");

const env = { ...process.env, HOME: home, PERSNALLY_DIR: join(home, ".persnally"), PERSNALLY_MCP: fakeMcp };

after(() => rmSync(home, { recursive: true, force: true }));

// Fake installed clients: claude-code (existing config with another server), cursor (dir only)
writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { other: { command: "x" } }, theme: "dark" }));
mkdirSync(join(home, ".cursor"));

test("connect --all writes installed clients, merges configs, skips missing", async () => {
  const { stdout } = await run("node", [CLI, "connect", "--all"], { env });
  assert.match(stdout, /Connected claude-code/);
  assert.match(stdout, /Connected cursor/);
  assert.match(stdout, /claude-desktop not installed — skipped/);

  const claude = JSON.parse(readFileSync(join(home, ".claude.json"), "utf-8"));
  assert.ok(claude.mcpServers.persnally.args[0].endsWith("index.js"));
  assert.equal(claude.mcpServers.other.command, "x", "existing servers preserved");
  assert.equal(claude.theme, "dark", "unrelated config preserved");

  const cursor = JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf-8"));
  assert.ok(cursor.mcpServers.persnally);
});

test("connect rejects unknown clients", async () => {
  // Not `vscode` — that is a supported client now. Any real editor name here is
  // one release away from becoming valid, so use one we will never ship.
  await assert.rejects(run("node", [CLI, "connect", "notepad"], { env }), /unknown client/);
});

test("connect issues an identity token: env in the client config, secret in ours, rotated per connect", async () => {
  await run("node", [CLI, "connect", "cursor"], { env });
  const mcp = () => JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf-8")).mcpServers.persnally.env;
  const cfg = () => JSON.parse(readFileSync(join(home, ".persnally", "config.json"), "utf-8")).client_tokens;

  const first = mcp();
  assert.equal(first.PERSNALLY_CLIENT, "cursor", "identity pinned to the connect-time name");
  assert.ok(first.PERSNALLY_CLIENT_TOKEN.length >= 32, "token is a real secret");
  assert.equal(cfg().cursor, first.PERSNALLY_CLIENT_TOKEN, "daemon config holds the same token");

  await run("node", [CLI, "connect", "cursor"], { env });
  assert.notEqual(mcp().PERSNALLY_CLIENT_TOKEN, first.PERSNALLY_CLIENT_TOKEN, "re-connect rotates");
  assert.equal(cfg().cursor, mcp().PERSNALLY_CLIENT_TOKEN, "both sides rotate together");
});

test("connect --scope sets the client's allowlist inline", async () => {
  const { stdout } = await run("node", [CLI, "connect", "cursor", "--scope", "technology,career"], { env });
  assert.match(stdout, /Connected cursor/);
  assert.match(stdout, /scoped cursor to: technology, career/);
  const cfg = JSON.parse(readFileSync(join(home, ".persnally", "config.json"), "utf-8"));
  assert.deepEqual(cfg.client_scopes.cursor, ["technology", "career"]);
});

test("connect --scope rejects invalid categories and --all", async () => {
  await assert.rejects(run("node", [CLI, "connect", "cursor", "--scope", "bogus"], { env }), /valid categories/);
  await assert.rejects(run("node", [CLI, "connect", "--all", "--scope", "technology"], { env }), /specific client/);
});

test("connect claude-code installs the SessionStart hook, merging + upgrading idempotently", async () => {
  const settings = join(home, ".claude", "settings.json");
  mkdirSync(join(home, ".claude"), { recursive: true });
  // Pre-existing: an OLD persnally hook (to upgrade) + an unrelated tool's hook (to preserve).
  writeFileSync(settings, JSON.stringify({
    permissions: { allow: ["Bash(ls:*)"] },
    hooks: {
      SessionStart: [
        { hooks: [{ type: "command", command: "persnallyd show topics | jq -Rs ." }] },
        { hooks: [{ type: "command", command: "echo unrelated-tool" }] },
      ],
    },
  }));

  await run("node", [CLI, "connect", "claude-code"], { env });
  await run("node", [CLI, "connect", "claude-code"], { env }); // re-run must stay idempotent

  const s = JSON.parse(readFileSync(settings, "utf-8"));
  const commands = (s.hooks.SessionStart as { hooks: { command: string }[] }[]).flatMap((g) => g.hooks.map((h) => h.command));
  const persnally = commands.filter((c) => /persnall/i.test(c));
  assert.equal(persnally.length, 1, "exactly one Persnally hook — no duplicates");
  assert.match(persnally[0]!, /persnallyd context --hook/, "old hook upgraded to the jq-free command");
  assert.ok(commands.includes("echo unrelated-tool"), "other tools' hooks preserved");
  assert.deepEqual(s.permissions.allow, ["Bash(ls:*)"], "unrelated settings preserved");
});
