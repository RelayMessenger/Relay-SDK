import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const releaseWorkflows = [
  {
    path: ".github/workflows/release-relaymessenger.yml",
    tagPattern: '"relaymessenger-v*"',
  },
  {
    path: ".github/workflows/release-vercel-ai.yml",
    tagPattern: '"vercel-ai-v*"',
  },
  {
    path: ".github/workflows/release-sdk.yml",
    tagPattern: '"sdk-v*"',
  },
  {
    path: ".github/workflows/release-chat-sdk.yml",
    tagPattern: '"chat-sdk-v*"',
  },
  {
    path: ".github/workflows/release-openclaw.yml",
    tagPattern: '"openclaw-v*"',
  },
  {
    path: ".github/workflows/release-claude-channel.yml",
    tagPattern: '"claude-channel-v*"',
  },
];

for (const { path, tagPattern } of releaseWorkflows) {
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
