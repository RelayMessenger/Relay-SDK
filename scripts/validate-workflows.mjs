import assert from "node:assert/strict";
import {
  readFileSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";

const rootManifest = JSON.parse(readFileSync("package.json", "utf8"));
const pinnedNode = readFileSync(".nvmrc", "utf8").trim();
assert.match(
  pinnedNode,
  /^\d+\.\d+\.\d+$/u,
  ".nvmrc must pin one exact Node version",
);
assert.equal(
  rootManifest.engines?.node,
  `>=${pinnedNode}`,
  ".nvmrc and engines.node must name the same Node version",
);

for (const name of readdirSync(".github/workflows").filter((value) =>
  value.endsWith(".yml") || value.endsWith(".yaml")
)) {
  const workflow = readFileSync(join(".github/workflows", name), "utf8");
  const uses = [...workflow.matchAll(/^\s*-\s*uses:\s*([^#\s]+)/gmu)]
    .map((match) => match[1]);
  assert.ok(uses.length > 0, `${name} has no Actions`);
  for (const action of uses) {
    if (action.startsWith("./")) continue;
    assert.match(
      action,
      /@[0-9a-f]{40}$/u,
      `${name} does not pin ${action} to an exact commit`,
    );
  }
  const setupNodeSteps = uses.filter((action) =>
    action.startsWith("actions/setup-node@")
  ).length;
  assert.doesNotMatch(
    workflow,
    /node-version:\s*\S/u,
    `${name} pins Node inline instead of reading .nvmrc`,
  );
  assert.equal(
    [...workflow.matchAll(/node-version-file:\s*\.nvmrc\s*$/gmu)].length,
    setupNodeSteps,
    `${name} must read every Node version from .nvmrc`,
  );
  for (
    const [, pinnedNpm] of workflow.matchAll(
      /npm\s+(?:install|i)\s+(?:--global|-g)\s+npm@(\S+)/gu,
    )
  ) {
    assert.match(
      pinnedNpm,
      /^\d+\.\d+\.\d+$/u,
      `${name} installs npm@${pinnedNpm} instead of an exact version`,
    );
  }
  for (const checkout of workflow.matchAll(
    /-\s*uses:\s*actions\/checkout@[0-9a-f]{40}([\s\S]*?)(?=\n\s*-\s+(?:uses|name|run):|\s*$)/gu,
  )) {
    assert.match(
      checkout[1],
      /persist-credentials:\s*false/u,
      `${name} checkout persists credentials`,
    );
  }
}

const publish = readFileSync(
  ".github/workflows/publish-package-staging.yml",
  "utf8",
);
assert.match(publish, /environment:\s*npm-staging/u);
assert.match(publish, /NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_PUBLISH_TOKEN \}\}/u);
assert.match(publish, /id-token:\s*write/u);
assert.match(publish, /github\.repository == 'RelayMessenger\/Relay-SDK'/u);
assert.match(publish, /github\.ref == 'refs\/heads\/staging'/u);
assert.match(
  publish,
  /push:\s*\n\s*branches:\s*\n\s*-\s*staging/u,
  "automatic publication must be staging-only",
);
assert.match(
  publish,
  /RELEASE_PACKAGE:\s*\$\{\{\s*github\.event_name == 'push' && 'claude-code' \|\| inputs\.package\s*\}\}/u,
  "a staging push may automatically select only the missing Claude package",
);
assert.match(
  publish,
  /RELEASE_SHA:\s*\$\{\{\s*github\.event_name == 'push' && github\.sha \|\| inputs\.commit_sha\s*\}\}/u,
  "a staging push must publish its exact event SHA",
);
const pushTrigger = publish.slice(
  publish.indexOf("  push:"),
  publish.indexOf("  workflow_dispatch:"),
);
assert.match(
  pushTrigger,
  /paths:[\s\S]*packages\/claude-code\/\*\*/u,
  "automatic Claude publication must be path-scoped",
);
assert.doesNotMatch(
  pushTrigger,
  /packages\/(?:chat-sdk-adapter|cli|mcp|openclaw)\/\*\*/u,
  "automatic publication must not select another package path",
);
const releaseOrder = [
  "Build the canonical SDK workspace",
  'id: resolve',
  "Validate selected package",
  "Verify validation kept the tracked tree clean",
  "Pack one retained tarball",
  "Verify Claude Code staging release identity",
  "Retain the release identity",
].map((marker) => publish.indexOf(marker));
assert.ok(
  releaseOrder.every((position) => position >= 0),
  "staging package workflow is missing a release gate",
);
assert.deepEqual(
  [...releaseOrder].sort((left, right) => left - right),
  releaseOrder,
  "build, validation, clean-tree, pack, identity, and retention gates drifted",
);
assert.match(
  publish,
  /RELEASE_TARBALL:\s*\$\{\{\s*steps\.pack\.outputs\.tarball\s*\}\}/u,
  "Claude release identity must bind the retained tarball",
);
assert.match(
  publish,
  /name:\s*relay-\$\{\{\s*env\.RELEASE_PACKAGE\s*\}\}-\$\{\{\s*github\.sha\s*\}\}/u,
  "package artifacts must use the resolved package and event SHA",
);
assert.ok(
  [...publish.matchAll(/test -z "\$\(git status --porcelain\)"/gu)]
    .length >= 3,
  "staging publication must prove clean tracked state before and after build",
);
assert.doesNotMatch(publish, /--tag\s+(?:latest|next)\b/u);

const publishProgram = readFileSync(
  "scripts/publish-package-staging.mjs",
  "utf8",
);
assert.match(
  publishProgram,
  /Array\.isArray\(parsed\) && parsed\.length === 1/u,
  "npm view must normalize npm 12's single-result array",
);
assert.match(
  publishProgram,
  /Array\.isArray\(existing\.value\)/u,
  "registry integrity reconciliation must defend against array output",
);
assert.match(
  publishProgram,
  /observedIntegrities,\s*\n\s*\[integrity\]/u,
  "registry integrity reconciliation must still require exactly one match",
);

// Sigstore verifies an npm attestation against GitHub-hosted runner identity
// and rejects every other runner with
// E422 "Unsupported GitHub Actions runner" (measured 2026-09-07 on staging
// d2e7caf). While any publish job runs on a Blacksmith label, the staging
// publish must ask npm for no attestation, and must ask for it explicitly:
// five packages still declare "provenance": true in publishConfig, and only a
// CLI flag outranks publishConfig (npm 12.0.2 lib/commands/publish.js).
const blacksmithRunners = [
  ...publish.matchAll(/runs-on:\s*(blacksmith-[\w.-]+)/gu),
].map(([, label]) => label);
if (blacksmithRunners.length > 0) {
  for (
    const [source, text] of [
      ["publish-package-staging.yml", publish],
      ["publish-package-staging.mjs", publishProgram],
    ]
  ) {
    assert.doesNotMatch(
      text,
      /--provenance\b/u,
      `${source} requests an npm attestation that Sigstore rejects on ${
        blacksmithRunners[0]
      }`,
    );
    assert.doesNotMatch(
      text,
      /NPM_CONFIG_PROVENANCE/u,
      `${source} sets NPM_CONFIG_PROVENANCE on ${blacksmithRunners[0]}`,
    );
  }
  assert.match(
    publishProgram,
    /"--no-provenance"/u,
    "the staging publish must disable the npm attestation explicitly, so no publishConfig can re-enable it",
  );
}

console.log("validated immutable CI and staging-only package publication");
