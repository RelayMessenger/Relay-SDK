import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const expected =
  "1b687dc9ffc7a6296a04b570d20fe32bed758deb2ed8f38fc48d0d44a10db2ec";
const copies = [
  "contracts/relay-v1-openapi.yaml",
  "packages/chat-sdk-adapter/contracts/relay-openapi.yaml",
  "packages/openclaw/contracts/relay-openapi.yaml",
  "cookbook/cloudflare-think-agent/contracts/relay-openapi.yaml",
];

for (const path of copies) {
  const digest = createHash("sha256")
    .update(await readFile(join(root, path)))
    .digest("hex");
  assert.equal(digest, expected, `${path} drifted from the Relay v1 contract`);
}

const skillLock = JSON.parse(
  await readFile(
    join(root, "skills/relay/references/relay-v1-lock.json"),
    "utf8",
  ),
);
assert.equal(skillLock.api.openapi_sha256, expected);
assert.equal(skillLock.api.commit, "ef8cedb1015e1e0d0856d61b69057f2b831f7c90");
assert.equal(skillLock.sdk.commit, "79517a1c9fcb1c82b474cd72ba8bc10197ff363f");
assert.equal(skillLock.sdk.version, "0.3.1-staging.1");
// The lock is what a customer's installed skill reads, on every branch, so its
// docs address is the production one even while this branch targets staging.
assert.equal(skillLock.docs_mcp.url, "https://docs.relayapp.im/mcp");

// The skill lock is historical source provenance, not the moving workspace version.
const sdkManifest = JSON.parse(await readFile(join(root, "packages/sdk/package.json"), "utf8"));
for (const path of [
  "packages/openclaw/contracts/relay-v1.lock.json",
  "packages/claude-code/contracts/relay-v1.lock.json",
  "packages/claude-code/plugin/contracts/relay-v1.lock.json",
]) {
  const lock = JSON.parse(await readFile(join(root, path), "utf8"));
  assert.equal(lock.relayServer.sha256, expected, `${path}: Server digest`);
  assert.equal(lock.relayServer.commit, skillLock.api.commit, `${path}: Server pin`);
  assert.equal(lock.relaySdk.workspaceOpenapiSha256, expected, `${path}: workspace digest`);
  assert.equal(lock.relaySdk.version, sdkManifest.version, `${path}: SDK version`);
}
assert.deepEqual(
  JSON.parse(await readFile(
    join(root, "plugins/relay/skills/relay/references/relay-v1-lock.json"),
    "utf8",
  )),
  skillLock,
  "portable skill lock must match the canonical skill lock",
);

console.log(`validated ${copies.length} byte-exact Relay v1 OpenAPI copies`);
