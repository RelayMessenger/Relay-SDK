import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const expected =
  "26a6bc047286e09df6ef95f3c6b09f0437260ecc94e12c5fb3ce1704910f8ba1";
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
assert.equal(skillLock.api.commit, "ddcbccb44b9f85e8c2e3e63fead9b81d52f2bd15");
assert.equal(skillLock.sdk.commit, "d3a8ae02143120868e304e3a1213148e53eac80b");
assert.equal(skillLock.sdk.version, "0.3.0-staging.6");

console.log(`validated ${copies.length} byte-exact Relay v1 OpenAPI copies`);
