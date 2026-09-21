import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const expected =
  "7f1056cd6d5dc81a1cd23f1e40520fc3c0a32b5a577dd222988fc26f92e6c8d4";
const manifest = JSON.parse(await readFile(join(root, "contracts/relay-v1-operations.json"), "utf8"));
assert.equal(manifest.source_openapi_sha256, expected);
assert.equal(manifest.upstream.sha256, expected);
assert.equal(manifest.upstream.commit, "56f31c13956ee41f4e2e5945973645e17faa3338");
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
// Historical published skill provenance intentionally remains independent of the local candidate.
assert.equal(skillLock.api.openapi_sha256, "9f3e662a13cd0e6b16a52fba4b53c75fe5817d134dcf152e00b054699c37839c");
assert.equal(skillLock.api.commit, "a25111520f7fc92c25ecd945d1dfc9afa9f60a1f");
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
  assert.equal(lock.relayServer.commit, "56f31c13956ee41f4e2e5945973645e17faa3338", `${path}: local Server pin`);
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
