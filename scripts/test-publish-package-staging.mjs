import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { test } from "node:test";

const program = resolve("scripts/publish-package-staging.mjs");
const name = "relay-claude-channel";
const version = "0.3.0-staging.5";

function exercise(t, { state, checkOnly = true, omitTarball = false }) {
  const root = mkdtempSync(join(tmpdir(), "relay-publisher-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "package"));
  writeFileSync(join(root, "package/package.json"), JSON.stringify({
    name, version,
    publishConfig: { tag: "staging", access: "public" },
    repository: { url: "git+https://github.com/RelayMessenger/Relay-SDK.git" },
  }));
  const tarball = join(root, "package.tgz");
  const packed = spawnSync("tar", ["-czf", tarball, "-C", root, "package"]);
  assert.equal(packed.status, 0, String(packed.stderr));
  const integrity = `sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`;
  const calls = join(root, "calls.jsonl");
  writeFileSync(calls, "");
  // Every npm call is intercepted: these tests cannot publish or access npm.
  writeFileSync(join(root, "npm"), `#!${process.execPath}
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.CALLS, JSON.stringify(args) + "\\n");
if (args[0] !== "view") {
  console.error("Mutation is forbidden in this fixture");
  process.exit(97);
}
if (process.env.STATE === "unknown") {
  console.error("E503 registry unavailable");
  process.exit(1);
}
if (args[2] === "dist-tags") {
  console.log(JSON.stringify([{ latest: "0.2.1", staging: "${version}" }]));
} else if (process.env.STATE === "absent") {
  console.error("E404 version not found");
  process.exit(1);
} else {
  console.log(JSON.stringify([process.env.STATE === "conflict" ? "sha512-other" : process.env.INTEGRITY]));
}
`, { mode: 0o755 });
  writeFileSync(join(root, "package.json"), '{"type":"module"}');
  const receipt = join(root, "receipt.json");
  const result = spawnSync(process.execPath, [
    program, "--package", name, "--receipt", receipt,
    ...(omitTarball ? [] : ["--tarball", tarball]),
    ...(checkOnly ? ["--check-only"] : []),
  ], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${root}${delimiter}${process.env.PATH}`,
      GITHUB_ACTIONS: "true", GITHUB_REF: "refs/heads/staging",
      STATE: state, CALLS: calls, INTEGRITY: integrity,
    },
  });
  const invocations = readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  assert.ok(invocations.every(([command]) => command === "view"), "must never mutate registry");
  return { ...result, receipt, invocations };
}

for (const state of ["absent", "exact"]) {
  test(`preflight accepts ${state} version without publishing`, (t) => {
    const result = exercise(t, { state });
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(readFileSync(result.receipt, "utf8"));
    assert.equal(receipt.publish_attempted, false);
    assert.equal(receipt.registry_state, state === "absent" ? "version-absent" : "exact-match");
  });
}
for (const checkOnly of [true, false]) {
  test(`different bytes reject before any mutation (checkOnly=${checkOnly})`, (t) => {
    const result = exercise(t, { state: "conflict", checkOnly });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Prepare a new release version/);
  });
}
test("unavailable registry fails closed", (t) => {
  const result = exercise(t, { state: "unknown" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /E503/);
});
test("existing exact tarball reconciles without republishing", (t) => {
  const result = exercise(t, { state: "exact", checkOnly: false });
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(readFileSync(result.receipt, "utf8"));
  assert.equal(receipt.publish_attempted, false);
  assert.equal(receipt.latest_unchanged, true);
});
test("missing tarball argument fails before any registry access", (t) => {
  const result = exercise(t, { state: "exact", omitTarball: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Usage:/);
  assert.equal(result.invocations.length, 0);
});
