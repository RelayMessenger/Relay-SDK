import assert from "node:assert/strict";
import {
  readFileSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";

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

console.log("validated immutable CI and staging-only package publication");
