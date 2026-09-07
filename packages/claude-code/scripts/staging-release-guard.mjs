import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const json = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));
const manifest = json("package.json");
const plugin = json(".claude-plugin/plugin.json");
const packagedPlugin = json("plugin/.claude-plugin/plugin.json");
const marketplace = json(".claude-plugin/marketplace.json");
const releaseSha = process.env.RELEASE_SHA ?? "";
const releaseVersion = process.env.RELEASE_VERSION ?? "";
const releaseTag = process.env.RELEASE_TAG ?? "";
const workflowSha = process.env.GITHUB_SHA ?? "";
const workflowRef = process.env.GITHUB_REF ?? "";
const workflowRepository = process.env.GITHUB_REPOSITORY ?? "";
const workflowWorkspace = process.env.GITHUB_WORKSPACE ?? "";
const releaseTarball = process.env.RELEASE_TARBALL ?? "";
const expectedRepository = "RelayMessenger/Relay-SDK";
const packagePath = "packages/claude-code";

assert.match(
  releaseSha,
  /^[0-9a-f]{40}$/u,
  "RELEASE_SHA must be one exact lowercase Git commit SHA",
);
assert.equal(
  workflowRepository,
  expectedRepository,
  "staging publication must run in RelayMessenger/Relay-SDK",
);
assert.equal(
  root,
  resolve(workflowWorkspace, packagePath),
  `staging publication must target ${packagePath}`,
);
const head = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
assert.equal(
  workflowRef,
  "refs/heads/staging",
  "staging publication must be dispatched from the staging branch",
);
assert.equal(
  workflowSha,
  releaseSha,
  "the workflow staging-branch SHA must equal RELEASE_SHA",
);
assert.equal(head, releaseSha, "the checked-out commit must equal RELEASE_SHA");
assert.equal(manifest.version, releaseVersion);
assert.match(releaseVersion, /^\d+\.\d+\.\d+-staging\.\d+$/u);
assert.equal(releaseTag, "staging");
assert.deepEqual(manifest.repository, {
  type: "git",
  url: "git+https://github.com/RelayMessenger/Relay-SDK.git",
  directory: packagePath,
});
assert.deepEqual(manifest.publishConfig, {
  access: "public",
  registry: "https://registry.npmjs.org/",
  tag: "staging",
  provenance: true,
});
assert.equal(plugin.version, releaseVersion);
assert.equal(packagedPlugin.version, releaseVersion);
assert.equal(marketplace.plugins?.[0]?.version, releaseVersion);

const runtime = readFileSync(join(root, "runtime/server.mjs"));
const packagedRuntime = readFileSync(join(root, "plugin/runtime/server.mjs"));
assert.deepEqual(runtime, packagedRuntime);
assert.ok(runtime.includes(Buffer.from(JSON.stringify(releaseVersion))));
const runtimeSha256 = createHash("sha256").update(runtime).digest("hex");

assert.equal(
  releaseTarball,
  resolve(releaseTarball),
  "RELEASE_TARBALL must be one absolute path",
);
assert.equal(
  dirname(releaseTarball),
  resolve(workflowWorkspace, ".release-tmp", "package-staging"),
  "RELEASE_TARBALL must be the retained package artifact",
);
const tarballRuntime = execFileSync(
  "tar",
  ["-xOzf", releaseTarball, "package/runtime/server.mjs"],
);
const tarballPluginRuntime = execFileSync(
  "tar",
  ["-xOzf", releaseTarball, "package/plugin/runtime/server.mjs"],
);
assert.deepEqual(
  tarballRuntime,
  runtime,
  "packed runtime differs from the validated workspace runtime",
);
assert.deepEqual(
  tarballPluginRuntime,
  runtime,
  "packed plugin runtime differs from the validated workspace runtime",
);

const receipt = {
  schema: "relay-claude-channel-staging-release-identity/v1",
  repository: expectedRepository,
  package_path: packagePath,
  sha: releaseSha,
  version: releaseVersion,
  tag: releaseTag,
  ref: workflowRef,
  runtime_sha256: runtimeSha256,
  tarball_runtime_sha256: createHash("sha256")
    .update(tarballRuntime)
    .digest("hex"),
};
const receiptDirectory = join(root, ".release", "npm-staging");
mkdirSync(receiptDirectory, { recursive: true });
writeFileSync(
  join(receiptDirectory, "release-identity.json"),
  `${JSON.stringify(receipt, null, 2)}\n`,
);
process.stdout.write(`${JSON.stringify(receipt)}\n`);
