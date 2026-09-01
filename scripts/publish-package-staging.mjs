import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";

const valueAfter = (name) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};
const tarball = resolve(valueAfter("--tarball") ?? "");
const expectedName = valueAfter("--package");
const receipt = resolve(
  valueAfter("--receipt") ?? ".release-tmp/package-publish.json",
);
if (!tarball || !expectedName) {
  throw new Error(
    "Usage: publish-package-staging --tarball <tgz> --package <name>",
  );
}
assert.equal(process.env.GITHUB_ACTIONS, "true");
assert.equal(process.env.GITHUB_REF, "refs/heads/staging");

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const registry = "https://registry.npmjs.org/";
const manifestResult = spawnSync(
  "tar",
  ["-xOzf", tarball, "package/package.json"],
  { encoding: "utf8" },
);
if (manifestResult.status !== 0) {
  throw new Error(manifestResult.stderr || "Could not read packed package.json");
}
const manifest = JSON.parse(manifestResult.stdout);
assert.equal(manifest.name, expectedName);
assert.match(manifest.version, /^\d+\.\d+\.\d+-staging\.\d+$/);
assert.equal(manifest.publishConfig?.tag, "staging");
assert.equal(manifest.publishConfig?.access, "public");
assert.equal(
  manifest.repository?.url,
  "git+https://github.com/RelayMessenger/Relay-SDK.git",
);

const bytes = readFileSync(tarball);
const integrity = `sha512-${
  createHash("sha512").update(bytes).digest("base64")
}`;
const spec = `${manifest.name}@${manifest.version}`;
const run = (args, allowFailure = false) => {
  const result = spawnSync(npm, args, {
    encoding: "utf8",
    env: process.env,
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `npm ${args[0]} failed`);
  }
  return result;
};
const view = (target, field) => {
  const result = run(
    ["view", target, field, "--json", "--registry", registry],
    true,
  );
  if (result.status !== 0) {
    if (/\bE404\b|is not in this registry/i.test(result.stderr)) {
      return { found: false };
    }
    throw new Error(result.stderr || result.stdout);
  }
  return { found: true, value: JSON.parse(result.stdout) };
};

const before = view(manifest.name, "dist-tags");
const latestBefore = before.found ? before.value.latest ?? null : null;
let existing = view(spec, "dist.integrity");
let publishAttempted = false;
if (!existing.found) {
  publishAttempted = true;
  const published = run([
    "publish",
    tarball,
    "--access",
    "public",
    "--tag",
    "staging",
    "--provenance",
    "--registry",
    registry,
  ], true);
  for (let attempt = 0; attempt < 18 && !existing.found; attempt += 1) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5_000));
    existing = view(spec, "dist.integrity");
  }
  if (!existing.found) {
    throw new Error(
      `Single publish attempt exited ${published.status}; registry is absent. `
        + `${published.stderr || published.stdout}`,
    );
  }
}
const observedIntegrities = Array.isArray(existing.value)
  ? existing.value
  : [existing.value];
assert.deepEqual(
  observedIntegrities,
  [integrity],
  `${spec} integrity differs`,
);
const after = view(manifest.name, "dist-tags");
assert.equal(after.found, true);
assert.equal(after.value.staging, manifest.version);
assert.equal(after.value.latest ?? null, latestBefore, "latest moved");

const result = {
  schema: "relay-monorepo-package-staging/v1",
  ok: true,
  package: spec,
  git_sha: process.env.GITHUB_SHA,
  workflow_run_id: process.env.GITHUB_RUN_ID,
  tarball_sha256: createHash("sha256").update(bytes).digest("hex"),
  integrity,
  publish_attempted: publishAttempted,
  latest_unchanged: true,
  dist_tags_before: before.found ? before.value : {},
  dist_tags_after: after.value,
};
mkdirSync(resolve(receipt, ".."), { recursive: true });
writeFileSync(receipt, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result));
