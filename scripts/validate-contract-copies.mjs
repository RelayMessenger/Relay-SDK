import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const expected =
  "e3f6c4616821a830f0c2aa908ee7e72e46359d6ff30ee4796cbbf651ea7df776";
const manifest = JSON.parse(await readFile(join(root, "contracts/relay-v1-operations.json"), "utf8"));
assert.equal(manifest.source_openapi_sha256, expected);
assert.equal(manifest.upstream.sha256, expected);
assert.equal(manifest.upstream.commit, "268245c52c1167322b2a2749871b9e3759a52c5e");
assert.equal(manifest.upstream.publication_status, "local-only");
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
// Historical published skill provenance intentionally remains independent of the local candidate.
assert.equal(skillLock.api.openapi_sha256, "27698655d12500fb9cd2e10dbf1c94025fbc64c288df6151db673a7649877111");
assert.equal(skillLock.api.commit, "eb83978b6b2c625da82471e4af16acad8de0e618");
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
  assert.equal(lock.relayServer.commit, "268245c52c1167322b2a2749871b9e3759a52c5e", `${path}: local Server pin`);
  assert.equal(lock.relayServer.publicationStatus, "local-only");
  assert.equal(lock.relaySdk.integrityScope, "historical-published-package; not the local selection candidate");
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
