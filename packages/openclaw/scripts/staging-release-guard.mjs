import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(
  readFileSync(join(root, "package.json"), "utf8"),
);
const releaseSha = process.env.RELEASE_SHA ?? "";
const releaseVersion = process.env.RELEASE_VERSION ?? "";
const releaseTag = process.env.RELEASE_TAG ?? "";
const workflowSha = process.env.GITHUB_SHA ?? "";
const workflowRef = process.env.GITHUB_REF ?? "";
const workflowRepository = process.env.GITHUB_REPOSITORY ?? "";
const workflowWorkspace = process.env.GITHUB_WORKSPACE ?? "";
const expectedRepository = "RelayMessenger/Relay-SDK";
const packagePath = "packages/openclaw";
const head = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();

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
assert.equal(
  head,
  releaseSha,
  "the checked-out commit must equal RELEASE_SHA",
);
assert.equal(
  manifest.version,
  releaseVersion,
  "RELEASE_VERSION must equal package.json version",
);
assert.match(
  releaseVersion,
  /^\d+\.\d+\.\d+-staging\.\d+$/u,
  "the staging version must be an exact SemVer staging prerelease",
);
assert.equal(
  releaseTag,
  "staging",
  "the only permitted distribution tag is staging",
);
assert.deepEqual(
  manifest.repository,
  {
    type: "git",
    url: "git+https://github.com/RelayMessenger/Relay-SDK.git",
    directory: packagePath,
  },
  "package repository metadata must target its Relay-SDK directory",
);
assert.deepEqual(
  manifest.publishConfig,
  {
    access: "public",
    tag: "staging",
    provenance: true,
  },
  "publishConfig must remain staging-only",
);

const receipt = {
  schema: "relay-openclaw-staging-release-identity/v1",
  repository: expectedRepository,
  package_path: packagePath,
  sha: releaseSha,
  version: releaseVersion,
  tag: releaseTag,
  ref: workflowRef,
};
const receiptDirectory = join(root, ".release", "npm-staging");
mkdirSync(receiptDirectory, { recursive: true });
writeFileSync(
  join(receiptDirectory, "release-identity.json"),
  `${JSON.stringify(receipt, null, 2)}\n`,
);
console.log(JSON.stringify(receipt));
