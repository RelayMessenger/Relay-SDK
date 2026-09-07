import assert from "node:assert/strict";
import {
  readFileSync,
  readdirSync,
} from "node:fs";
import { basename, join } from "node:path";
import { releasePackages } from "./release-packages.mjs";

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

const workflowFiles = readdirSync(".github/workflows")
  .filter((value) => value.endsWith(".yml") || value.endsWith(".yaml"))
  .sort()
  .map((entry) => [
    join(".github/workflows", entry),
    readFileSync(join(".github/workflows", entry), "utf8"),
  ]);

for (const [path, workflow] of workflowFiles) {
  const name = basename(path);
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
// d2e7caf). npm's OIDC trusted publishing carries the same restriction, in its
// own words: "Trusted publishing currently supports only cloud-hosted
// runners." Every job in this repository runs on Blacksmith (owner ruling,
// 2026-09-07), so neither is available and every publish authenticates with a
// token and asks for no attestation.
//
// The negation has to be explicit at every call site, not merely absent: five
// packages still declare "provenance": true in publishConfig, and only a CLI
// flag outranks publishConfig (npm 12.0.2 lib/commands/publish.js). Those five
// keys stay where they are because packages/claude-code and packages/openclaw
// assert them in their own contract guards and tests; this file is what makes
// them inert, by proving no publish anywhere can ask for an attestation.
const scriptFiles = readdirSync("scripts")
  .filter((name) => name.endsWith(".mjs"))
  // This file quotes the flags it forbids, so it cannot be swept for them.
  .filter((name) => name !== "validate-workflows.mjs")
  .map((name) => [join("scripts", name), readFileSync(join("scripts", name), "utf8")]);

for (const [source, text] of [...workflowFiles, ...scriptFiles]) {
  assert.doesNotMatch(
    text,
    /--provenance\b/u,
    `${source} requests an npm attestation that Sigstore rejects on Blacksmith`,
  );
  assert.doesNotMatch(
    text,
    /NPM_CONFIG_PROVENANCE/u,
    `${source} sets NPM_CONFIG_PROVENANCE, which Blacksmith cannot satisfy`,
  );
  // Only real invocations: a line that starts with the command, plus the
  // flag lines a folded YAML block continues it with. Prose that quotes
  // `npm publish --dry-run` is documentation, not a call site.
  for (
    const [invocation] of text.matchAll(
      /^[ \t]*npm publish\b[^\n]*(?:\n[ \t]+--[^\n]*)*/gmu,
    )
  ) {
    assert.match(
      invocation,
      /--no-provenance/u,
      `${source} publishes without disabling the npm attestation: ${invocation}`,
    );
  }
}
assert.match(
  publishProgram,
  /"--no-provenance"/u,
  "the staging publish must disable the npm attestation explicitly, so no publishConfig can re-enable it",
);

// Every job in this repository runs on Blacksmith (owner ruling, 2026-09-07).
for (const [source, text] of workflowFiles) {
  const labels = [...text.matchAll(/runs-on:\s*(\S+)/gu)].map(([, label]) => label);
  assert.ok(labels.length > 0, `${source} declares no runner`);
  for (const label of labels) {
    assert.match(
      label,
      /^blacksmith-/u,
      `${source} runs on ${label} instead of a Blacksmith runner`,
    );
  }
}

// The one production release workflow. Tags record a publish and never
// trigger one, so no workflow may listen for a tag push.
const release = readFileSync(".github/workflows/release.yml", "utf8");
assert.match(
  release,
  /^on:\n\s*push:\n\s*branches:\n\s*-\s*main$/mu,
  "the production release runs on a push to main",
);
assert.match(release, /^\s*dry_run:$/mu, "release.yml has no dry_run input");
assert.match(
  release,
  /^\s*environment: npm-release$/mu,
  "release.yml does not publish through the npm-release environment",
);
assert.match(
  release,
  /NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_PUBLISH_TOKEN \}\}/u,
  "release.yml does not authenticate with NPM_PUBLISH_TOKEN",
);
assert.doesNotMatch(release, /secrets\.NPM_TOKEN\b/u);
assert.match(
  release,
  /^\s*if: github\.event_name == 'push'\n\s*env:\n(?:.*\n){1,3}\s*run: node scripts\/release-run\.mjs$/mu,
  "only a push to main may run the publishing release",
);
assert.match(release, /run: node scripts\/release-run\.mjs --dry-run$/mu);
assert.match(release, /run: node --test scripts\/release-derive\.test\.mjs$/mu);
for (const [source, text] of workflowFiles) {
  assert.doesNotMatch(
    text,
    /^\s*tags:\s*$/mu,
    `${source} triggers on a tag; tags record a release and never start one`,
  );
}
const releaseRun = readFileSync("scripts/release-run.mjs", "utf8");
assert.match(
  releaseRun,
  /"publish", tarball\.path,\n\s*"--access", "public",\n\s*"--tag", "latest",\n\s*"--no-provenance",/u,
  "the release publish must be public, latest, and unattested at the call site",
);
for (const [key, entry] of Object.entries(releasePackages)) {
  const manifest = JSON.parse(
    readFileSync(join(entry.directory, "package.json"), "utf8"),
  );
  assert.equal(
    manifest.name,
    entry.workspace,
    `${entry.directory} is ${manifest.name}, not the catalogued ${entry.workspace}`,
  );
  assert.equal(manifest.repository?.directory, entry.directory);
  assert.ok(
    rootManifest.scripts?.[entry.validate],
    `the root package has no ${entry.validate} script for ${key}`,
  );
  assert.match(entry.tagPrefix, /^[a-z-]+-v$/u, `${key} has no record tag series`);
}

console.log(
  `validated immutable CI, staging-only package publication, and the ${
    Object.keys(releasePackages).length
  }-package release on main`,
);
