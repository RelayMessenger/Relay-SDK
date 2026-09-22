import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(await readFile(join(root, "contracts/relay-v1-operations.json"), "utf8"));
const expected = manifest.source_openapi_sha256;
assert.match(expected, /^[a-f0-9]{64}$/u);
assert.equal(manifest.upstream.sha256, expected);
assert.ok(
  /^[a-f0-9]{40}$/u.test(manifest.upstream.commit)
    || (manifest.upstream.commit === "PENDING" && manifest.upstream.publication_status === "local-only"),
  "Server contract commit must be a durable pin or an explicit local candidate",
);
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

// Coordinated local checkouts carry these exact bytes too. Standalone public
// SDK checkouts need neither private Server access nor a Docs checkout.
for (const path of [
  "../server/contracts/developer/openapi.yaml",
  "../docs/api-reference/openapi.yaml",
]) {
  if (!existsSync(join(root, path))) continue;
  const digest = createHash("sha256")
    .update(await readFile(join(root, path)))
    .digest("hex");
  assert.equal(digest, expected, `${path} drifted from canonical SDK bytes`);
}

const skillLock = JSON.parse(
  await readFile(
    join(root, "skills/relay/references/relay-v1-lock.json"),
    "utf8",
  ),
);
assert.equal(skillLock.api.openapi_sha256, expected);
assert.equal(skillLock.api.commit, "979fa43e72abf033442805b112897d0b5fed0533");
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
  assert.equal(lock.relayServer.commit, manifest.upstream.commit, `${path}: local Server pin`);
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
