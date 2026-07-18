import assert from "node:assert/strict";
import { test } from "node:test";
import { parseFlags } from "./flags.js";

test("the unavailable staging deployment flag is rejected instead of falling back", () => {
  assert.throws(() => parseFlags(["--staging"]), /no live staging API origin/);
});
