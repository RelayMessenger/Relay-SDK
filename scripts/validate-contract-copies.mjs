import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const expected =
  "e58ffd5de05250a7a218735cb6bffd854d2d1198134f3f8876b2be109f606fde";
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
assert.equal(skillLock.api.commit, "4506b8cb6f41da0b39f3e23a285daf3805fcf3a3");
assert.equal(skillLock.sdk.commit, "ddb78e385800d82b041441698985fafab3d9aba9");
assert.equal(skillLock.sdk.version, "0.3.0-staging.7");

console.log(`validated ${copies.length} byte-exact Relay v1 OpenAPI copies`);
