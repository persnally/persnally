/**
 * Setup has to be drivable by an agent, which means no TTY. Before these flags
 * the only non-interactive outcome was the degraded one: the model-download
 * consent could be given by a human at a prompt and no other way, so an agent
 * always ended up with a git-only mirror and no way to say otherwise.
 */

import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { parseEngineOptions } from "../src/cli.js";
import { chooseExtractor } from "../src/llm.js";

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

  test("--engine given twice is rejected rather than taking the first", () => {
    // indexOf would return "none" here and silently ignore the malformed second
    // value, which is the same class of quiet wrong-engine bug as the fallback.
    assert.throws(() => parseEngineOptions(["--engine", "none", "--engine", "gpt4"]), /more than once/);
  });
});

describe("a forced engine is honoured strictly — this is a custody guarantee", () => {
  const KEY = "ANTHROPIC_API_KEY";
  const restore = process.env[KEY];
  after(() => { if (restore === undefined) delete process.env[KEY]; else process.env[KEY] = restore; });

  test("--engine ollama never resolves to Anthropic, even with a key set", async () => {
    process.env[KEY] = "sk-ant-test";
    // Asserted as an invariant rather than a specific outcome, because it must
    // hold both ways: with Ollama present it resolves locally, without it it
    // fails. The one thing it must never do is quietly ship conversation text
    // to Anthropic after the user asked for local-only — which is exactly what
    // it did before, since chooseExtractor checked the key first.
    const outcome = await chooseExtractor("extract", "ollama").then(
      (e) => e.label,
      (e: Error) => `rejected: ${e.message}`,
    );
    assert.doesNotMatch(outcome, /Anthropic/, `forced ollama resolved to: ${outcome}`);
    assert.match(outcome, /local via Ollama|rejected: .*Ollama/);
  });

  test("--engine anthropic fails when no key is set instead of falling back to Ollama", async () => {
    delete process.env[KEY];
    await assert.rejects(() => chooseExtractor("extract", "anthropic"), /no API key is set/);
  });

  test("--engine anthropic uses the key when one is set", async () => {
    process.env[KEY] = "sk-ant-test";
    const e = await chooseExtractor("extract", "anthropic");
    assert.match(e.label, /Anthropic API/);
  });

  test("unforced resolution keeps the old preference order", async () => {
    process.env[KEY] = "sk-ant-test";
    assert.match((await chooseExtractor("extract")).label, /Anthropic API/);
  });
});
