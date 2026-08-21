import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import test from "node:test";

// npm trusted publishing matches the workflow *filename* exactly, so the file
// that publishes a package is part of that package's release identity. Keeping
// the filename, the release script, the retained artifact, and the packed
// workspace on one slug is what makes that identity readable from either end:
// npm's trust record names `release-<slug>.yml`, and the file it names is
// obviously the one that publishes `packageName`. The slug comes from the
// filename here so a rename that misses any of those four places fails.
//
// `tagPattern` is deliberately not derived from the slug. Tags name a release
// series that already exists in git history, so they outlive a file rename:
// `@relaymessenger/cli` publishes from `release-cli.yml` but keeps the
// `relaymessenger-v*` series it has always used, which is also the name of the
// binary it installs. Only the filename is load-bearing for npm.
const releaseWorkflows = [
  {
    path: ".github/workflows/release-cli.yml",
    packageName: "@relaymessenger/cli",
    tagPattern: '"relaymessenger-v*"',
  },
  {
    path: ".github/workflows/release-vercel-ai.yml",
    packageName: "@relaymessenger/vercel-ai",
    tagPattern: '"vercel-ai-v*"',
  },
  {
    path: ".github/workflows/release-sdk.yml",
    packageName: "@relaymessenger/sdk",
    tagPattern: '"sdk-v*"',
  },
  {
    path: ".github/workflows/release-chat-sdk.yml",
    packageName: "@relaymessenger/chat-sdk-adapter",
    tagPattern: '"chat-sdk-v*"',
  },
  {
    path: ".github/workflows/release-openclaw.yml",
    packageName: "@relaymessenger/openclaw-plugin",
    tagPattern: '"openclaw-v*"',
  },
  {
    path: ".github/workflows/release-claude-channel.yml",
    packageName: "relay-claude-channel",
    tagPattern: '"claude-channel-v*"',
  },
];

test("every release workflow on disk is covered by this file", () => {
  const present = readdirSync(new URL("../.github/workflows/", import.meta.url))
    .filter((entry) => entry.startsWith("release-"))
    .sort();
  const covered = releaseWorkflows.map(({ path }) => path.split("/").pop()).sort();

  assert.deepEqual(present, covered);
});

for (const { path, packageName, tagPattern } of releaseWorkflows) {
  const slug = /release-(?<slug>.+)\.yml$/u.exec(path).groups.slug;

  test(`${path} names the package it publishes`, () => {
    const workflow = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

    assert.match(workflow, new RegExp(`^name: Release ${packageName} to npm$`, "mu"));
    assert.match(
      workflow,
      new RegExp(`^\\s*name: Validate, publish, and verify ${packageName}$`, "mu"),
    );
    // The one publish in the file must pack this package and no other.
    assert.match(workflow, new RegExp(`npm pack --workspace ${packageName} `, "u"));
    // The retained artifact and the release script carry the filename's slug,
    // so the trust record's filename leads to every part of the release.
    assert.match(
      workflow,
      new RegExp(`^\\s*name: ${slug}-\\$\\{\\{ steps\\.source\\.outputs\\.sha \\}\\}$`, "mu"),
    );
    assert.match(workflow, new RegExp(`scripts/${slug}-release\\.mjs`, "u"));
    assert.ok(
      existsSync(new URL(`../scripts/${slug}-release.mjs`, import.meta.url)),
      `${path} references scripts/${slug}-release.mjs, which does not exist`,
    );
  });

  test(`${path} publishes only from its tag event`, () => {
    const workflow = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

    assert.match(workflow, new RegExp(`^\\s*- ${tagPattern.replaceAll("*", "\\*")}$`, "mu"));
    assert.doesNotMatch(workflow, /^\s*workflow_dispatch\s*:/mu);
    assert.doesNotMatch(workflow, /\binputs\.tag\b/u);
    assert.match(workflow, /^\s*RELEASE_TAG: \$\{\{ github\.ref_name \}\}\s*$/mu);
    assert.match(workflow, /^\s*ref: \$\{\{ github\.ref_name \}\}\s*$/mu);
  });

  test(`${path} publishes OIDC releases from a supported GitHub runner`, () => {
    const workflow = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

    assert.match(workflow, /^\s*runs-on: ubuntu-24\.04\s*$/mu);
    assert.doesNotMatch(workflow, /^\s*runs-on: blacksmith-/mu);
    assert.match(workflow, /^\s*id-token: write\s*$/mu);
  });

  test(`${path} lets npm reach the OIDC exchange instead of publishing anonymously`, () => {
    const workflow = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

    // setup-node's registry-url writes `_authToken=${NODE_AUTH_TOKEN}` into the
    // job npmrc. Left in place with no token set, npm treats the empty value as
    // configured credentials, skips trusted publishing, and publishes
    // anonymously; the registry rejects that as an unrelated-looking E404.
    assert.match(workflow, /^\s*grep -v ':_authToken=' "\$npmrc"/mu);
    assert.match(workflow, /^\s*! grep -q ':_authToken=' "\$npmrc"/mu);
    assert.match(workflow, /^\s*test -n "\$\{ACTIONS_ID_TOKEN_REQUEST_URL:-\}"\s*$/mu);
  });

  test(`${path} names a missing trusted-publisher record instead of leaving ENEEDAUTH`, () => {
    const workflow = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

    assert.match(workflow, /oidc\/token\/exchange\/package/u);
    // Only a definitive "not configured" answer may block a release; an
    // unreachable registry must fall through to npm publish rather than
    // inventing a new way for releases to fail.
    assert.match(workflow, /^\s*if \[\[ "\$status" == "404" \]\]; then$/mu);
    assert.match(workflow, /leaving the verdict to npm publish/u);
    // A successful exchange returns a live publish token.
    assert.match(workflow, /^\s*rm -f "\$body"$/mu);
  });

  test(`${path} never publishes with a long-lived token`, () => {
    const workflow = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

    assert.doesNotMatch(workflow, /secrets\.NPM_TOKEN/u);
    assert.doesNotMatch(workflow, /^\s*NODE_AUTH_TOKEN:/mu);
  });
}
