import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const valueAfter = (name) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};

const tarballArgument = valueAfter("--tarball");
const receiptArgument = valueAfter("--receipt")
  ?? ".release-tmp/npm-staging-publish.json";
if (!tarballArgument) {
  throw new Error(
    "Usage: node scripts/publish-staging.mjs --tarball <tarball> "
      + "[--receipt <path>]",
  );
}
if (process.env.GITHUB_ACTIONS !== "true") {
  throw new Error("Registry mutation is allowed only inside GitHub Actions.");
}
if (process.env.GITHUB_REF !== "refs/heads/staging") {
  throw new Error("Registry mutation is allowed only from the staging branch.");
}

const tarball = resolve(tarballArgument);
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const registry = "https://registry.npmjs.org/";
const packageName = "@relaymessenger/sdk";
const manifestResult = spawnSync(
  "tar",
  ["-xOzf", tarball, "package/package.json"],
  { encoding: "utf8" },
);
if (manifestResult.status !== 0) {
  throw new Error(`Could not read packed package.json: ${manifestResult.stderr}`);
}
const manifest = JSON.parse(manifestResult.stdout);
assert.equal(manifest.name, packageName);
assert.match(
  manifest.version,
  /^\d+\.\d+\.\d+-staging\.\d+$/,
  "Staging releases require an explicit staging prerelease version.",
);
assert.deepEqual(manifest.publishConfig, {
  access: "public",
  registry,
  tag: "staging",
});

const version = manifest.version;
const packageSpec = `${packageName}@${version}`;
const bytes = readFileSync(tarball);
const localIntegrity = `sha512-${
  createHash("sha512").update(bytes).digest("base64")
}`;

const runNpm = (args, { allowFailure = false } = {}) => {
  const result = spawnSync(npm, args, {
    encoding: "utf8",
    env: process.env,
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `npm ${args[0]} failed`);
  }
  return result;
};

const viewJSON = (spec, field) => {
  const result = runNpm(
    ["view", spec, field, "--json", "--registry", registry],
    { allowFailure: true },
  );
  if (result.status !== 0) {
    if (/\bE404\b|is not in this registry/i.test(result.stderr)) {
      return { found: false };
    }
    throw new Error(
      `Registry state is unknown for ${spec}: ${result.stderr || result.stdout}`,
    );
  }
  return {
    found: true,
    value: JSON.parse(result.stdout),
  };
};

const parseCore = (versionValue) => {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(versionValue);
  if (!match) throw new Error(`Invalid registry version: ${versionValue}`);
  return match.slice(1).map(Number);
};
const compareCore = (left, right) => {
  const a = parseCore(left);
  const b = parseCore(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
};

const tagsBefore = viewJSON(packageName, "dist-tags");
assert.equal(tagsBefore.found, true, "The existing package must be readable.");
assert.equal(typeof tagsBefore.value.latest, "string");
assert.ok(
  compareCore(version, tagsBefore.value.latest) > 0,
  `${version} must have a newer core version than latest ${tagsBefore.value.latest}`,
);
const latestBefore = tagsBefore.value.latest;

let existing = viewJSON(packageSpec, "dist.integrity");
let publishAttempted = false;
let publishExit = 0;
let publishError = "";
if (!existing.found) {
  publishAttempted = true;
  const publish = runNpm([
    "publish",
    tarball,
    "--access",
    "public",
    "--tag",
    "staging",
    "--registry",
    registry,
  ], { allowFailure: true });
  publishExit = publish.status ?? 1;
  publishError = publish.stderr || publish.stdout;

  for (let attempt = 0; attempt < 18; attempt += 1) {
    existing = viewJSON(packageSpec, "dist.integrity");
    if (existing.found) break;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5_000));
  }
  if (!existing.found) {
    throw new Error(
      `The single npm publish attempt exited ${publishExit}, and ${packageSpec} `
        + `did not appear in the registry. No retry was attempted. ${publishError}`,
    );
  }
}

assert.equal(
  existing.value,
  localIntegrity,
  "The registry version exists with a different tarball integrity.",
);
const tagsAfter = viewJSON(packageName, "dist-tags");
assert.equal(tagsAfter.found, true);
assert.equal(tagsAfter.value.latest, latestBefore, "latest must not move.");
assert.equal(tagsAfter.value.staging, version, "staging must select this release.");

const receipt = {
  schema: "relay-sdk-npm-staging-publish/v1",
  ok: true,
  package: packageSpec,
  git_sha: process.env.GITHUB_SHA,
  workflow_run_id: process.env.GITHUB_RUN_ID,
  tarball_sha256: createHash("sha256").update(bytes).digest("hex"),
  integrity: localIntegrity,
  publish_attempted: publishAttempted,
  publish_exit: publishExit,
  dist_tags_before: tagsBefore.value,
  dist_tags_after: tagsAfter.value,
  latest_unchanged: true,
  published_at: new Date().toISOString(),
};
const receiptPath = resolve(receiptArgument);
mkdirSync(resolve(receiptPath, ".."), { recursive: true });
writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify(receipt));
