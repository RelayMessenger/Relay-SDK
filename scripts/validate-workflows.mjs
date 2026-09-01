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
assert.doesNotMatch(publish, /--tag\s+(?:latest|next)\b/u);

console.log("validated immutable CI and staging-only package publication");
