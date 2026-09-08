import assert from "node:assert/strict";
import {
  readFileSync,
  readdirSync,
} from "node:fs";
import { basename, join } from "node:path";
import { releasePackages } from "./release-packages.mjs";
import { validateRunnerPolicy } from "./agent-cli-platforms-policy.mjs";
import { verifyPolicyFixtures } from "./agent-cli-platforms-policy-fixtures.mjs";

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

// The staging release: every push to staging versions what changed and
// publishes it (owner ruling, 2026-09-07: releases are automatic, nothing
// manual, ever). publish-package-staging.yml bumps and commits, then calls
// staging-package.yml once per changed package in catalog order.
const staging = readFileSync(
  ".github/workflows/publish-package-staging.yml",
  "utf8",
);
assert.match(staging, /github\.repository == 'RelayMessenger\/Relay-SDK'/u);
assert.match(staging, /github\.ref == 'refs\/heads\/staging'/u);
assert.match(
  staging,
  /^on:\n\s*push:\n\s*branches:\n\s*-\s*staging\n\npermissions:/mu,
  "the staging release runs on every push to staging and on nothing else",
);
assert.doesNotMatch(
  staging,
  /workflow_dispatch/u,
  "the staging release has no manual path",
);
assert.match(
  staging,
  /^\s*cancel-in-progress: true$/mu,
  "a newer push to staging must cancel the run in flight",
);
assert.match(
  staging,
  /run: node --test scripts\/staging-bump\.test\.mjs\n\s*- id: plan\n\s*name: [^\n]*\n\s*run: node scripts\/staging-bump\.mjs --write$/mu,
  "the bump job proves the decision table before it writes",
);
assert.match(
  staging,
  /git push "https:\/\/x-access-token:\$\{GITHUB_TOKEN\}@github\.com\/\$\{GITHUB_REPOSITORY\}\.git" HEAD:staging/u,
  "the bump commits to staging with the job token, so its push starts no second run",
);
assert.match(staging, /user\.name 'github-actions\[bot\]'/u);
const stagingOrder = Object.keys(releasePackages);
const called = [...staging.matchAll(/^\s*package: ([a-z-]+)$/gmu)].map(([, key]) => key);
assert.deepEqual(
  called,
  stagingOrder,
  "the staging release must call every catalog package once, in catalog order",
);
for (const [position, key] of stagingOrder.entries()) {
  const job = staging.slice(staging.indexOf(`\n  ${key}:\n`));
  assert.match(
    job,
    /^\s*uses: \.\/\.github\/workflows\/staging-package\.yml$/mu,
    `${key} must publish through staging-package.yml`,
  );
  assert.match(
    job,
    new RegExp(`contains\\(needs\\.bump\\.outputs\\.changed, ',${key},'\\)`, "u"),
    `${key} publishes only when the bump changed it`,
  );
  assert.match(
    job,
    /^\s*sha: \$\{\{ needs\.bump\.outputs\.sha \}\}$/mu,
    `${key} must publish the bump commit`,
  );
  if (position > 0) {
    const previous = stagingOrder[position - 1];
    assert.match(
      job,
      new RegExp(`needs: \\[bump, (?:sdk, )?${previous}\\]|needs: \\[bump, ${previous}\\]`, "u"),
      `${key} must wait for ${previous}, the package before it in the catalog`,
    );
  }
}

const publish = readFileSync(".github/workflows/staging-package.yml", "utf8");
assert.match(publish, /environment:\s*npm-staging/u);
assert.match(publish, /NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_PUBLISH_TOKEN \}\}/u);
// A called workflow may only keep or reduce the caller's GITHUB_TOKEN
// permissions; the staging release grants contents: read, and a callee that
// asked for id-token: write made GitHub refuse the run at startup
// (run 34153613220, 2026-09-07). The publish needs no OIDC token: it uses the
// environment credential and --no-provenance.
assert.doesNotMatch(
  publish,
  /^\s*[a-z-]+:\s*write$/mu,
  "staging-package.yml asks for a write permission its caller never grants",
);
assert.doesNotMatch(staging, /id-token/u, "the staging release needs no OIDC token");
assert.match(publish, /github\.repository == 'RelayMessenger\/Relay-SDK'/u);
assert.match(publish, /github\.ref == 'refs\/heads\/staging'/u);
assert.match(
  publish,
  /^on:\n\s*workflow_call:/mu,
  "one package's staging publish runs only when the staging release calls it",
);
assert.match(
  publish,
  /RELEASE_SHA:\s*\$\{\{\s*inputs\.sha\s*\}\}/u,
  "a package publishes the exact commit the staging release names",
);
assert.match(
  publish,
  /git merge-base --is-ancestor "\$EVENT_SHA" HEAD/u,
  "the published commit must descend from the pushed commit",
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
  /name:\s*relay-\$\{\{\s*env\.RELEASE_PACKAGE\s*\}\}-\$\{\{\s*env\.RELEASE_SHA\s*\}\}/u,
  "package artifacts must use the resolved package and published SHA",
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

// The caller event SHA predates the automatic bump; only the verified input
// can identify the retained tarball's checkout and successful receipt.
assert.match(publishProgram, /git_sha: releaseSha/u);
assert.doesNotMatch(publishProgram, /git_sha: (?:process\.)?env\.GITHUB_SHA/u);
const publishJob = publish.slice(publish.indexOf("\n  publish:\n"));
assert.ok(
  publishJob.indexOf('test "$(git rev-parse HEAD)" = "$RELEASE_SHA"') >= 0
    && publishJob.indexOf('test "$(git rev-parse HEAD)" = "$RELEASE_SHA"') < publishJob.indexOf("Publish or reconcile exactly once"),
  "publish job must verify RELEASE_SHA before entering the publish step",
);
const bumpProgram = readFileSync("scripts/staging-bump.mjs", "utf8");
for (const script of ["sync-root-discovery.mjs", "sync-import-metadata.mjs", "validate-contract-copies.mjs", "validate-workflows.mjs"]) {
  assert.ok(bumpProgram.includes(`"scripts/${script}"`), `bump omits coupled metadata step ${script}`);
}
assert.match(staging, /git add .*\.claude-plugin\/marketplace\.json .*sources\.import-manifest\.json/u);
assert.equal(rootManifest.scripts.postinstall, "node scripts/link-cookbook-workspaces.mjs");

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

// Owner-authorized native verification exception; every other workflow stays Blacksmith-only.
for (const [source, text] of workflowFiles) validateRunnerPolicy(source, text);
const nativeWorkflow = workflowFiles.find(([source]) => source.endsWith("/agent-cli-platforms.yml"));
if (nativeWorkflow) verifyPolicyFixtures(nativeWorkflow[1]);

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
// The staging bump rehearses on every change the way the release does: the
// same decisions against the live registry, writing nothing.
const ci = readFileSync(".github/workflows/ci.yml", "utf8");
assert.match(ci, /run: node --test scripts\/staging-bump\.test\.mjs$/mu);
assert.match(ci, /run: node scripts\/staging-bump\.mjs --dry-run$/mu);
assert.doesNotMatch(ci, /staging-bump\.mjs --write/u, "CI never writes a bump");
for (const [source, text] of workflowFiles) {
  assert.doesNotMatch(
    text,
    /^\s*tags:\s*$/mu,
    `${source} triggers on a tag; tags record a release and never start one`,
  );
}
const releaseRun = readFileSync("scripts/release-run.mjs", "utf8");
// Every publish waits through npm's post-publish processing with the one
// shared budget; a private loop drifted to 90 s and failed a publish that had
// succeeded (run 34154163996, 2026-09-07).
for (const [source, text] of [
  ["scripts/publish-package-staging.mjs", publishProgram],
  ["scripts/release-run.mjs", releaseRun],
]) {
  assert.match(
    text,
    /verifyNpmRegistryIntegrity\(\{[\s\S]*?\.\.\.PUBLISH_PROPAGATION,/u,
    `${source} must wait for propagation through verifyNpmRegistryIntegrity with PUBLISH_PROPAGATION`,
  );
  assert.doesNotMatch(
    text,
    /setTimeout\([^)]*,\s*\d[\d_]*\)/u,
    `${source} carries a private registry wait`,
  );
}
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
