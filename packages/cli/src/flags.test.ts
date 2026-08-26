import assert from "node:assert/strict";
import { test } from "node:test";
import { parseFlags } from "./flags.js";
import { ENGINE_NAMES } from "./engine/catalog.js";

test("the unavailable staging deployment flag is rejected instead of falling back", () => {
  assert.throws(() => parseFlags(["--staging"]), /no live staging API origin/);
});

test("every documented ACP preset is accepted and unknown engines fail", () => {
  for (const engine of ENGINE_NAMES) {
    assert.equal(parseFlags(["--engine", engine]).engine, engine);
  }
  assert.throws(() => parseFlags(["--engine", "made-up-agent"]), /must be one of/);
});

test("the agent's name and handle are separate flags, and neither accepts an empty value", () => {
  const flags = parseFlags(["--name", "Work Laptop", "--handle", "work_laptop"]);
  assert.equal(flags.name, "Work Laptop");
  assert.equal(flags.handle, "work_laptop");
  assert.equal(parseFlags([]).handle, undefined);
  assert.throws(() => parseFlags(["--handle"]), /--handle needs a value/);
});
