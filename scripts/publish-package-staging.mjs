import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import {
  PUBLISH_PROPAGATION,
  verifyNpmRegistryIntegrity as defaultVerifyNpmRegistryIntegrity,
} from "./verify-npm-registry-integrity.mjs";

const valueAfter = (args, name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

/**
 * Publish one already-packed staging package, or prove that the same bytes are
 * already in npm. The dependency injection is deliberately small: tests can
 * prove the release identity and registry reconciliation without contacting
 * npm, while the CLI remains the only production entry point.
 */
export async function publishPackageStaging({
  args = process.argv.slice(2),
  env = process.env,
  spawn = spawnSync,
  verifyNpmRegistryIntegrity = defaultVerifyNpmRegistryIntegrity,
} = {}) {
  const tarballArg = valueAfter(args, "--tarball");
  const expectedName = valueAfter(args, "--package");
  const receiptArg = valueAfter(args, "--receipt");
  if (!tarballArg || !expectedName) {
    throw new Error(
      "Usage: publish-package-staging --tarball <tgz> --package <name>",
    );
  }
  assert.equal(env.GITHUB_ACTIONS, "true");
  assert.equal(env.GITHUB_REF, "refs/heads/staging");
  assert.match(env.RELEASE_SHA ?? "", /^[0-9a-f]{40}$/u, "RELEASE_SHA");

  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const registry = "https://registry.npmjs.org/";
  const tarball = resolve(tarballArg);
  const receipt = resolve(receiptArg ?? ".release-tmp/package-publish.json");
  const checkedOut = spawn("git", ["rev-parse", "HEAD"], { encoding: "utf8", env });
  if (checkedOut.status !== 0) {
    throw new Error(checkedOut.stderr || "Could not read checkout SHA");
  }
  assert.equal(checkedOut.stdout.trim(), env.RELEASE_SHA, "Checkout differs from RELEASE_SHA");

  const manifestResult = spawn(
    "tar", ["-xOzf", tarball, "package/package.json"],
    { encoding: "utf8", env },
  );
  if (manifestResult.status !== 0) {
    throw new Error(manifestResult.stderr || "Could not read packed package.json");
  }
  const manifest = JSON.parse(manifestResult.stdout);
  assert.equal(manifest.name, expectedName);
  assert.match(manifest.version, /^\d+\.\d+\.\d+-staging\.\d+$/u);
  assert.equal(manifest.publishConfig?.tag, "staging");
  assert.equal(manifest.publishConfig?.access, "public");
  assert.equal(
    manifest.repository?.url,
    "git+https://github.com/RelayMessenger/Relay-SDK.git",
  );

  const bytes = readFileSync(tarball);
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  const spec = `${manifest.name}@${manifest.version}`;
  const run = (npmArgs, allowFailure = false) => {
    const result = spawn(npm, npmArgs, { encoding: "utf8", env });
    if (!allowFailure && result.status !== 0) {
      throw new Error(result.stderr || result.stdout || `npm ${npmArgs[0]} failed`);
    }
    return result;
  };
  const view = (target, field) => {
    const result = run(
      ["view", target, field, "--json", "--registry", registry], true,
    );
    if (result.status !== 0) {
      if (/\bE404\b|is not in this registry/iu.test(result.stderr)) {
        return { found: false };
      }
      throw new Error(result.stderr || result.stdout);
    }
    const parsed = JSON.parse(result.stdout);
    return {
      found: true,
      value: Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : parsed,
    };
  };

  const before = view(manifest.name, "dist-tags");
  const latestBefore = before.found ? before.value.latest ?? null : null;
  let existing = view(spec, "dist.integrity");
  let publishAttempted = false;
  if (!existing.found) {
    publishAttempted = true;
    const published = run([
      "publish", tarball, "--access", "public", "--tag", "staging",
      "--no-provenance", "--registry", registry,
    ], true);
    if (published.status !== 0) {
      throw new Error(
        `Single publish attempt exited ${published.status}. `
        + `${published.stderr || published.stdout}`,
      );
    }
    await verifyNpmRegistryIntegrity({
      packageSpec: spec,
      expectedIntegrity: integrity,
      ...PUBLISH_PROPAGATION,
    });
    existing = view(spec, "dist.integrity");
    assert.equal(existing.found, true, `${spec} vanished after propagation`);
  }
  const observedIntegrities = Array.isArray(existing.value)
    ? existing.value : [existing.value];
  assert.deepEqual(
    observedIntegrities,
    [integrity],
    `${spec} integrity differs`,
  );
  const after = view(manifest.name, "dist-tags");
  assert.equal(after.found, true);
  assert.equal(after.value.staging, manifest.version);
  assert.equal(after.value.latest ?? null, latestBefore, "latest moved");

  const releaseSha = env.RELEASE_SHA;
  const result = {
    schema: "relay-monorepo-package-staging/v1",
    ok: true,
    package: spec,
    git_sha: releaseSha,
    workflow_run_id: env.GITHUB_RUN_ID,
    tarball_sha256: createHash("sha256").update(bytes).digest("hex"),
    integrity,
    publish_attempted: publishAttempted,
    latest_unchanged: true,
    dist_tags_before: before.found ? before.value : {},
    dist_tags_after: after.value,
  };
  mkdirSync(resolve(receipt, ".."), { recursive: true });
  writeFileSync(receipt, `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  publishPackageStaging()
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
