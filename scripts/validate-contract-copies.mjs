import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const expected =
  "bbcdc6988e09feeeac1ae28cf299904b59e220ac7b5f936009845ad07645ead2";
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
assert.equal(skillLock.api.commit, "f91f22ea55ac0485efa181bb650998848c973c6e");
assert.equal(skillLock.sdk.commit, "1bbcb486b4a91860ee3527ce95d015883e4cc1ae");
assert.equal(skillLock.sdk.version, "0.3.0-staging.8");

console.log(`validated ${copies.length} byte-exact Relay v1 OpenAPI copies`);
