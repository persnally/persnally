/**
 * The three incidents this exists to catch all happened on the maintainer's own
 * machine and none of them surfaced anywhere: a CLI that lost its executable
 * bit, a daemon left a full version behind after an upgrade, and live capture
 * that stopped for two days. Each has a test named for it below — if one of
 * these ever passes when it shouldn't, the failure goes silent again.
 */

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, describe, test } from "node:test";
import {
  checkBins, checkCapture, checkDaemon, checkEngine, checkHook,
  installedHook, newestSession, render, resolveBin, runChecks, worst,
  type Facts,
} from "../src/doctor.js";

const dir = mkdtempSync(join(tmpdir(), "doctor-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const NOW = Date.parse("2026-08-10T12:00:00Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const DAY = 86_400_000;

const healthy: Facts = {
  cliVersion: "3.0.0",
  daemonVersion: "3.0.0",
  daemonPid: 123,
  autostartInstalled: true,
  bins: [
    { name: "persnally", path: "/usr/local/bin/persnally", executable: true },
    { name: "persnallyd", path: "/usr/local/bin/persnallyd", executable: true },
    { name: "persnally-mcp", path: "/usr/local/bin/persnally-mcp", executable: true },
  ],
  lastReadAt: iso(2 * 3600_000),
  newestSessionAt: iso(3 * 3600_000),
  hookCommand: "persnallyd context --hook 2>/dev/null",
  pluginHook: false,
  hasEngine: true,
  now: NOW,
  platform: "darwin",
};
const facts = (over: Partial<Facts>): Facts => ({ ...healthy, ...over });

describe("a healthy install reports healthy", () => {
  test("every check passes and nothing suggests a fix", () => {
    const checks = runChecks(healthy);
    assert.equal(worst(checks), "ok");
    assert.ok(checks.every((c) => !c.fix), "a passing check must not tell the user to fix anything");
  });

  test("render says so in words, not just symbols", () => {
    assert.match(render(runChecks(healthy)), /Everything is healthy/);
  });
});

describe("incident: the CLI lost its executable bit", () => {
  test("a resolvable but non-executable binary fails", () => {
    const c = checkBins(facts({
      bins: [{ name: "persnally", path: "/usr/local/bin/persnally", executable: false }],
    }));
    assert.equal(c.level, "fail");
    assert.match(c.title, /Not executable/);
    assert.match(c.fix!, /chmod \+x \/usr\/local\/bin\/persnally/, "the fix must be runnable as printed");
  });

  test("a missing binary is reported as missing, not as unrunnable", () => {
    const c = checkBins(facts({ bins: [{ name: "persnally-mcp", path: null, executable: false }] }));
    assert.equal(c.level, "fail");
    assert.match(c.title, /Not on PATH/);
    assert.match(c.fix!, /npm install -g/);
  });

  test("Windows has no executable bit, so it is not treated as breakage", () => {
    const c = checkBins(facts({
      platform: "win32",
      bins: [{ name: "persnally", path: "C:\\bin\\persnally", executable: false }],
    }));
    assert.equal(c.level, "ok", "flagging every Windows install would make the check noise");
  });
});

describe("incident: the daemon stayed a version behind after an upgrade", () => {
  test("a version mismatch is a failure, not a note", () => {
    const c = checkDaemon(facts({ daemonVersion: "2.10.0", cliVersion: "3.0.0" }));
    assert.equal(c.level, "fail", "the shipped fixes are simply not running — that is broken, not cosmetic");
    assert.match(c.title, /2\.10\.0.*3\.0\.0/);
    assert.match(c.fix!, /restart/);
  });

  test("an unreachable daemon fails, and says so differently when autostart claims to own it", () => {
    const plain = checkDaemon(facts({ daemonVersion: null, autostartInstalled: false }));
    const supervised = checkDaemon(facts({ daemonVersion: null, autostartInstalled: true }));
    assert.equal(plain.level, "fail");
    assert.equal(supervised.level, "fail");
    assert.notEqual(plain.detail, supervised.detail, "a supervisor that failed to respawn is a different problem");
    assert.match(supervised.detail, /supervisor/);
  });

  test("matching versions pass", () => {
    assert.equal(checkDaemon(facts({ daemonVersion: "3.0.0", cliVersion: "3.0.0" })).level, "ok");
  });
});

describe("incident: live capture stopped and nothing said so", () => {
  test("sessions newer than the last context read by two days is a failure", () => {
    const c = checkCapture(facts({
      lastReadAt: iso(4 * DAY),
      newestSessionAt: iso(1 * DAY),
    }));
    assert.equal(c.level, "fail");
    assert.match(c.title, /Capture stopped 3 day/);
    assert.match(c.detail, /Sessions ran and got nothing/);
  });

  test("transcripts but no read ever recorded is a failure", () => {
    const c = checkCapture(facts({ lastReadAt: null }));
    assert.equal(c.level, "fail");
    assert.match(c.title, /Never served context/);
  });

  test("a read after the newest session is current", () => {
    assert.equal(checkCapture(facts({ lastReadAt: iso(0), newestSessionAt: iso(DAY) })).level, "ok");
  });

  test("a gap under the threshold is not flagged — a quiet day is not a fault", () => {
    const c = checkCapture(facts({ lastReadAt: iso(2 * DAY), newestSessionAt: iso(DAY) }));
    assert.equal(c.level, "ok", "one day between a session and a read is ordinary");
  });

  test("no Claude Code sessions at all is not a failure", () => {
    const c = checkCapture(facts({ newestSessionAt: null, lastReadAt: null }));
    assert.equal(c.level, "ok", "there is nothing to have missed");
  });
});

describe("hook and engine are warnings, not failures", () => {
  test("a missing hook warns — context still works when a tool asks", () => {
    const c = checkHook(facts({ hookCommand: null }));
    assert.equal(c.level, "warn");
    assert.match(c.fix!, /connect claude-code/);
  });

  test("no engine warns — git and voice still work offline", () => {
    const c = checkEngine(facts({ hasEngine: false }));
    assert.equal(c.level, "warn");
    assert.match(c.detail, /git and voice still work/);
  });

  test("warnings alone do not make the run a failure", () => {
    const checks = runChecks(facts({ hookCommand: null, hasEngine: false }));
    assert.equal(worst(checks), "warn", "exit code must distinguish degraded from broken");
  });
});

describe("the Claude Code plugin can own the hook", () => {
  test("plugin only: healthy, and nothing tells the user to run connect", () => {
    const c = checkHook(facts({ hookCommand: null, pluginHook: true }));
    assert.equal(c.level, "ok");
    assert.match(c.title, /plugin/);
    assert.equal(c.fix, undefined);
  });

  test("plugin and settings.json both: a warning whose fix names the settings entry", () => {
    const c = checkHook(facts({ pluginHook: true }));
    assert.equal(c.level, "warn");
    assert.match(c.title, /twice/);
    assert.match(c.fix!, /settings\.json/);
  });
});

describe("reading real state off disk", () => {
  test("resolveBin finds a binary on PATH and reports its executability", () => {
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    const exe = join(bin, "persnally-test");
    writeFileSync(exe, "#!/bin/sh\n");
    chmodSync(exe, 0o644);

    const notExec = resolveBin("persnally-test", bin);
    assert.equal(notExec.path, exe);
    assert.equal(notExec.executable, false, "0644 must not read as runnable");

    chmodSync(exe, 0o755);
    assert.equal(resolveBin("persnally-test", bin).executable, true);
  });

  test("resolveBin returns a null path when nothing matches, across several PATH entries", () => {
    const b = resolveBin("definitely-not-installed", [dir, join(dir, "bin")].join(delimiter));
    assert.deepEqual(b, { name: "definitely-not-installed", path: null, executable: false });
  });

  test("newestSession takes the newest transcript across project directories", () => {
    const root = join(dir, "projects");
    mkdirSync(join(root, "a"), { recursive: true });
    mkdirSync(join(root, "b"), { recursive: true });
    const older = join(root, "a", "s1.jsonl");
    const newer = join(root, "b", "s2.jsonl");
    writeFileSync(older, "{}\n");
    writeFileSync(newer, "{}\n");
    utimesSync(older, new Date("2026-01-01"), new Date("2026-01-01"));
    utimesSync(newer, new Date("2026-08-09"), new Date("2026-08-09"));

    assert.equal(newestSession(root)!.slice(0, 10), "2026-08-09");
  });

  test("newestSession ignores non-transcripts and a missing directory", () => {
    const root = join(dir, "only-junk");
    mkdirSync(join(root, "p"), { recursive: true });
    writeFileSync(join(root, "p", "notes.md"), "x");
    assert.equal(newestSession(root), null, ".md is not a session");
    assert.equal(newestSession(join(dir, "does-not-exist")), null);
  });

  test("installedHook finds the Persnally hook and ignores other people's hooks", () => {
    const f = join(dir, "settings.json");
    writeFileSync(f, JSON.stringify({
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: "some-other-tool --init" }] },
          { hooks: [{ type: "command", command: "persnallyd context --hook 2>/dev/null" }] },
        ],
      },
    }));
    assert.match(installedHook(f)!, /persnallyd context --hook/);
  });

  test("installedHook returns null for absent, unparseable, or hook-free settings", () => {
    const missing = join(dir, "nope.json");
    const broken = join(dir, "broken.json");
    const empty = join(dir, "empty.json");
    writeFileSync(broken, "{ not json");
    writeFileSync(empty, JSON.stringify({ hooks: { SessionStart: [] } }));

    assert.equal(installedHook(missing), null);
    // A settings file the user broke is theirs to fix; a diagnostic must not
    // throw on its way to telling them what is wrong.
    assert.doesNotThrow(() => installedHook(broken));
    assert.equal(installedHook(broken), null);
    assert.equal(installedHook(empty), null);
  });
});

describe("output is actionable", () => {
  test("every non-ok check carries a fix", () => {
    const checks = runChecks(facts({
      daemonVersion: "2.10.0", hookCommand: null, hasEngine: false, lastReadAt: null,
      bins: [{ name: "persnally", path: null, executable: false }],
    }));
    for (const c of checks.filter((x) => x.level !== "ok")) {
      assert.ok(c.fix, `${c.id} reports a problem with no way to resolve it`);
    }
  });

  test("render marks failures distinctly and states the overall verdict", () => {
    const out = render(runChecks(facts({ daemonVersion: "2.10.0" })));
    assert.match(out, /✗/);
    assert.match(out, /Something is broken/);
  });
});
