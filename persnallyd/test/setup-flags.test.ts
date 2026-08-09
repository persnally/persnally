/**
 * Setup has to be drivable by an agent, which means no TTY. Before these flags
 * the only non-interactive outcome was the degraded one: the model-download
 * consent could be given by a human at a prompt and no other way, so an agent
 * always ended up with a git-only mirror and no way to say otherwise.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseEngineOptions } from "../src/cli.js";

describe("--engine selects the extractor explicitly", () => {
  test("each valid value parses", () => {
    for (const e of ["ollama", "anthropic", "none"] as const) {
      assert.equal(parseEngineOptions(["--engine", e]).engine, e);
    }
  });

  test("omitting it means the usual preference order, not a default choice", () => {
    assert.equal(parseEngineOptions([]).engine, null);
  });

  test("an unknown value is rejected by name rather than silently ignored", () => {
    // Silently falling back would hand the user a different engine than they
    // asked for, which is worse than failing.
    assert.throws(() => parseEngineOptions(["--engine", "gpt4"]), /must be ollama, anthropic or none/);
    assert.throws(() => parseEngineOptions(["--engine", "gpt4"]), /gpt4/);
  });

  test("a bare --engine with nothing after it is rejected", () => {
    assert.throws(() => parseEngineOptions(["--engine"]), /must be ollama, anthropic or none/);
  });
});

describe("--yes is the agent's consent for the model download", () => {
  test("both spellings work", () => {
    assert.equal(parseEngineOptions(["--yes"]).yes, true);
    assert.equal(parseEngineOptions(["-y"]).yes, true);
  });

  test("absent means absent — consent is never assumed", () => {
    assert.equal(parseEngineOptions([]).yes, false);
    assert.equal(parseEngineOptions(["--engine", "none"]).yes, false);
  });

  test("flags combine and do not interfere with other arguments", () => {
    const o = parseEngineOptions(["--port", "5000", "--yes", "--engine", "ollama"]);
    assert.deepEqual(o, { yes: true, engine: "ollama" });
  });

  test("a value that merely contains 'yes' is not consent", () => {
    assert.equal(parseEngineOptions(["--engine", "none", "--yesterday"]).yes, false);
  });
});
