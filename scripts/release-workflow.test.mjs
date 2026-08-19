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
}
