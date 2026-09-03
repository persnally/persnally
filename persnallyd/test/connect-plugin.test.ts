/**
 * The Claude Code plugin ships the same SessionStart hook `connect` installs.
 * With both, every session injects the context twice — so `connect` must yield
 * to an installed, enabled plugin and otherwise behave exactly as before.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "connect-plugin-"));
const store = mkdtempSync(join(tmpdir(), "connect-plugin-store-"));
// connect.ts reads homedir() at call time, so the env must be set before import.
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.PERSNALLY_DIR = store;

const { claudeCodePluginInstalled, installClaudeCodeHook } = await import("../src/connect.js");

const claude = join(home, ".claude");
const settings = join(claude, "settings.json");
const installed = join(claude, "plugins", "installed_plugins.json");

function reset(): void {
  rmSync(claude, { recursive: true, force: true });
  mkdirSync(join(claude, "plugins"), { recursive: true });
}
/** Records an install the way Claude Code does, with the plugin's manifest on disk at installPath. */
function installPlugin(key = "persnally@persnally", opts: { scope?: string; hook?: string | null } = {}): void {
  const installPath = join(claude, "plugins", "cache", key.replace("@", "-"));
  mkdirSync(join(installPath, "hooks"), { recursive: true });
  const hook = opts.hook === undefined ? "persnallyd context --hook --client=claude-code 2>/dev/null" : opts.hook;
  if (hook !== null) {
    writeFileSync(join(installPath, "hooks", "hooks.json"),
      JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: hook }] }] } }));
  }
  writeFileSync(installed, JSON.stringify({ version: 2, plugins: { [key]: [{ scope: opts.scope ?? "user", version: "0.1.0", installPath }] } }));
}
function hooksIn(file: string): unknown[] {
  if (!existsSync(file)) return [];
  const cfg = JSON.parse(readFileSync(file, "utf-8")) as { hooks?: { SessionStart?: unknown[] } };
  return cfg.hooks?.SessionStart ?? [];
}

beforeEach(reset);
after(() => { rmSync(home, { recursive: true, force: true }); rmSync(store, { recursive: true, force: true }); });

test("no plugin records → not installed, and the hook is written as before", () => {
  assert.equal(claudeCodePluginInstalled(), false);
  assert.equal(installClaudeCodeHook(), settings);
  assert.equal(hooksIn(settings).length, 1);
});

test("an installed plugin owns the hook: connect writes nothing and says so", () => {
  installPlugin();
  assert.equal(claudeCodePluginInstalled(), true);
  assert.equal(installClaudeCodeHook(), null);
  assert.equal(existsSync(settings), false, "settings.json must not be created just to skip");
});

test("the plugin can come from any marketplace, but only one that ships our hook counts", () => {
  installPlugin("persnally@claude-community");
  assert.equal(claudeCodePluginInstalled(), true, "our plugin listed in the community marketplace");
  reset();
  installPlugin("remember@claude-plugins-official");
  assert.equal(claudeCodePluginInstalled(), false, "another memory plugin is not ours");
  reset();
  installPlugin("persnally@someone-else", { hook: "echo hi" });
  assert.equal(claudeCodePluginInstalled(), false, "a same-named plugin whose manifest lacks our hook owns nothing");
  reset();
  installPlugin("persnally@someone-else", { hook: null });
  assert.equal(claudeCodePluginInstalled(), false, "no hooks manifest at all");
  assert.equal(installClaudeCodeHook(), settings, "so connect installs its own hook");
});

test("a project- or local-scoped plugin covers one repository, so the user hook is still ours to install", () => {
  installPlugin("persnally@persnally", { scope: "project" });
  assert.equal(claudeCodePluginInstalled(), false);
  assert.equal(installClaudeCodeHook(), settings);
  reset();
  installPlugin("persnally@persnally", { scope: "local" });
  assert.equal(claudeCodePluginInstalled(), false);
});

test("a disabled plugin contributes no hook, so connect installs its own", () => {
  installPlugin();
  writeFileSync(settings, JSON.stringify({ enabledPlugins: { "persnally@persnally": false } }));
  assert.equal(claudeCodePluginInstalled(), false);
  assert.equal(installClaudeCodeHook(), settings);
  const cfg = JSON.parse(readFileSync(settings, "utf-8")) as { enabledPlugins?: unknown; hooks?: unknown };
  assert.deepEqual(cfg.enabledPlugins, { "persnally@persnally": false }, "unrelated settings survive");
  assert.equal(hooksIn(settings).length, 1);
});

test("an unreadable plugin registry is treated as no plugin, never as an error", () => {
  writeFileSync(installed, "{ not json");
  assert.equal(claudeCodePluginInstalled(), false);
  assert.equal(installClaudeCodeHook(), settings);
});

test("re-running connect after the plugin appears removes nothing but adds nothing", () => {
  assert.equal(installClaudeCodeHook(), settings);
  installPlugin();
  assert.equal(installClaudeCodeHook(), null);
  assert.equal(hooksIn(settings).length, 1, "the earlier hook is left for the user to remove — connect never deletes");
});
