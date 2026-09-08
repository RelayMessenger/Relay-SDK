import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { publishPackageStaging } from "./publish-package-staging.mjs";

function fixture(t, { releaseSha = "a".repeat(40), head = "a".repeat(40), exists = true, publishStatus = 0, conflict = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "publish-mock-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const tarball = join(dir, "mock.tgz");
  writeFileSync(tarball, "mock retained bytes");
  const integrity = `sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`;
  const calls = [];
  let visible = exists;
  const options = {
    args: ["--tarball", tarball, "--package", "@relaymessenger/sdk", "--receipt", join(dir, "receipt.json")],
    env: { GITHUB_ACTIONS: "true", GITHUB_REF: "refs/heads/staging", RELEASE_SHA: releaseSha, GITHUB_SHA: "b".repeat(40) },
    spawn(command, args) {
      calls.push([command, ...args]);
      if (command === "git") return { status: 0, stdout: head };
      if (command === "tar") return { status: 0, stdout: JSON.stringify({ name: "@relaymessenger/sdk", version: "0.9.0-staging.1", publishConfig: { tag: "staging", access: "public" }, repository: { url: "git+https://github.com/RelayMessenger/Relay-SDK.git" } }) };
      assert.match(command, /^npm(?:\.cmd)?$/u);
      if (args[0] === "publish") return { status: publishStatus, stderr: "mock ambiguous outcome" };
      assert.equal(args[0], "view");
      if (args[2] === "dist-tags") return { status: 0, stdout: JSON.stringify({ latest: "0.8.0", staging: "0.9.0-staging.1" }) };
      return visible ? { status: 0, stdout: JSON.stringify(conflict ? "sha512-conflict" : integrity) } : { status: 1, stderr: "E404" };
    },
    async verifyNpmRegistryIntegrity(input) {
      calls.push(["verify", input.maxAttempts, input.retryDelayMs]);
      assert.equal(input.expectedIntegrity, integrity);
      visible = true;
    },
  };
  return { options, calls, dir };
}

for (const exists of [true, false]) test(`receipt uses verified bump SHA, not event SHA (exists=${exists})`, async (t) => {
  const { options, calls, dir } = fixture(t, { exists });
  const result = await publishPackageStaging(options);
  assert.equal(result.git_sha, options.env.RELEASE_SHA);
  assert.notEqual(result.git_sha, options.env.GITHUB_SHA);
  assert.equal(JSON.parse(readFileSync(join(dir, "receipt.json"))).git_sha, options.env.RELEASE_SHA);
  assert.equal(calls.filter((row) => row[1] === "publish").length, exists ? 0 : 1);
  assert.equal(calls[0][0], "git");
});
for (const bad of [undefined, "", "staging", "a".repeat(39)]) test(`invalid RELEASE_SHA fails before npm: ${bad}`, async (t) => {
  const { options, calls } = fixture(t);
  options.env.RELEASE_SHA = bad;
  await assert.rejects(publishPackageStaging(options), /RELEASE_SHA/u);
  assert.deepEqual(calls, []);
});
test("checkout mismatch fails before reading tarball or contacting npm", async (t) => {
  const { options, calls } = fixture(t, { head: "c".repeat(40) });
  await assert.rejects(publishPackageStaging(options), /Checkout differs/u);
  assert.deepEqual(calls.map((row) => row[0]), ["git"]);
});
test("ambiguous nonzero publish reconciles with shared budget and never republishes", async (t) => {
  const { options, calls } = fixture(t, { exists: false, publishStatus: 1 });
  assert.equal((await publishPackageStaging(options)).ok, true);
  assert.equal(calls.filter((row) => row[1] === "publish").length, 1);
  assert.deepEqual(calls.find((row) => row[0] === "verify"), ["verify", 60, 10000]);
});
test("existing conflicting integrity fails without mutation", async (t) => {
  const { options, calls } = fixture(t, { conflict: true });
  await assert.rejects(publishPackageStaging(options), /integrity differs/u);
  assert.equal(calls.filter((row) => row[1] === "publish").length, 0);
});
test("unresolved ambiguous publication fails without retry", async (t) => {
  const { options, calls } = fixture(t, { exists: false, publishStatus: 1 });
  options.verifyNpmRegistryIntegrity = async () => { throw new Error("budget exhausted"); };
  await assert.rejects(publishPackageStaging(options), /budget exhausted/u);
  assert.equal(calls.filter((row) => row[1] === "publish").length, 1);
});
