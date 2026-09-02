import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const expected =
  "86163217bb7273d7d438d9861fb4456978df587d941e5803c97e43eb1ee00682";
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
assert.equal(skillLock.api.commit, "f6e96c7520c301f04ab2182a85a961cf05c4ed07");
assert.equal(skillLock.sdk.commit, "776a9a7873f41c0c9947439c44444674a7d55c5d");
assert.equal(skillLock.sdk.version, "0.3.0-staging.5");

console.log(`validated ${copies.length} byte-exact Relay v1 OpenAPI copies`);
