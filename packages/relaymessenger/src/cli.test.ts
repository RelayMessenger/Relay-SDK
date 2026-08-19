import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

/**
 * The version has to come off the installed manifest. A constant would let a
 * release ship a number that disagrees with the package it arrived in.
 */
test("every version flag prints the manifest version", () => {
  const { version } = require("../package.json") as { version: string };
  for (const flag of ["--version", "-v", "version"]) {
    const printed = execFileSync(process.execPath, [cli, flag], { encoding: "utf8" }).trim();
    assert.equal(printed, version, `${flag} printed ${printed}`);
  }
});

test("an unknown command still fails rather than printing a version", () => {
  assert.throws(() =>
    execFileSync(process.execPath, [cli, "--verzion"], { encoding: "utf8", stdio: "pipe" }),
  );
});
