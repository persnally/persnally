import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { autostartInstalled, installAutostart, LOG_FILE, removeAutostart, renderSystemdUnit } from "../src/lifecycle.js";

const dir = mkdtempSync(join(tmpdir(), "systemd-test-"));
process.env.XDG_CONFIG_HOME = dir; // unitPath() resolves at call time — isolate from any real ~/.config
const UNIT = join(dir, "systemd", "user", "persnally.service");

const realPlatform = process.platform;
function fakePlatform(p: string): void {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}
after(() => { fakePlatform(realPlatform); rmSync(dir, { recursive: true, force: true }); });

test("renderSystemdUnit produces a complete, log-wired user unit", () => {
  const unit = renderSystemdUnit("/opt/persnally/cli.js", 4983);
  assert.match(unit, /ExecStart=".*node.*" "\/opt\/persnally\/cli\.js" serve --port 4983/);
  assert.match(unit, /Restart=always/);
  assert.match(unit, new RegExp(`StandardOutput=append:${LOG_FILE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(unit, /WantedBy=default\.target/);
});

test("renderSystemdUnit escapes quotes and backslashes in paths", () => {
  const unit = renderSystemdUnit('/weird/pa"th\\cli.js', 4983);
  assert.match(unit, /"\/weird\/pa\\"th\\\\cli\.js"/, "quote and backslash are C-escaped inside the quoted arg");
});

test("unsupported platforms fail loudly and report as not installed", () => {
  fakePlatform("win32");
  try {
    assert.equal(autostartInstalled(), false);
    assert.throws(() => installAutostart("/x/cli.js", 4983), /macOS \(launchd\) and Linux \(systemd\)/);
  } finally {
    fakePlatform(realPlatform);
  }
});

// Skipped on real Linux: these would talk to the host's live systemd.
test("linux: installed-state tracks the unit file; a failed enable cleans up after itself",
  { skip: realPlatform === "linux" }, () => {
  fakePlatform("linux");
  try {
    assert.equal(autostartInstalled(), false, "no unit file → not installed");

    // systemctl is unavailable on this host → install must throw AND remove the
    // half-written unit, so installed-state never lies.
    assert.throws(() => installAutostart("/x/cli.js", 4983), /could not be enabled/);
    assert.equal(existsSync(UNIT), false, "failed install leaves no unit behind");
    assert.equal(autostartInstalled(), false);

    // A unit that exists (e.g. installed when systemd was reachable) is reported and removable.
    mkdirSync(join(dir, "systemd", "user"), { recursive: true });
    writeFileSync(UNIT, renderSystemdUnit("/x/cli.js", 4983));
    assert.equal(autostartInstalled(), true);
    assert.equal(removeAutostart(), true, "remove succeeds even when systemctl is unreachable");
    assert.equal(existsSync(UNIT), false);
    assert.equal(removeAutostart(), false, "second remove is a no-op");
  } finally {
    fakePlatform(realPlatform);
  }
});
