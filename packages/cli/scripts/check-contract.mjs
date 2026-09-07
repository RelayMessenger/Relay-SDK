import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RELAY_V1_OPERATIONS } from "@relaymessenger/sdk";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const manifest = JSON.parse(
  await readFile(resolve(root, "package.json"), "utf8"),
);
const source = JSON.parse(
  await readFile(resolve(root, "SOURCE.json"), "utf8"),
);
const sourceLock = JSON.parse(
  await readFile(resolve(root, "../..", "sources.lock.json"), "utf8"),
);
const expected = (
  await readFile(resolve(root, "contracts/sdk-v1-operations.sha256"), "utf8")
).trim();
const actual = createHash("sha256")
  .update(JSON.stringify(RELAY_V1_OPERATIONS))
  .digest("hex");
const sdkPackagePath = require.resolve("@relaymessenger/sdk/package.json");
const sdkTypes = await readFile(
  resolve(dirname(sdkPackagePath), "dist/types.d.ts"),
  "utf8",
);

assert.equal(
  actual,
  expected,
  "The SDK v1 operation contract changed; review the public contract before refreshing this hash.",
);
assert.equal(RELAY_V1_OPERATIONS.length, 36);
assert.match(sdkTypes, /\bimage_url: string \| null;/u);
assert.match(sdkTypes, /\babout: string \| null;/u);
assert.doesNotMatch(sdkTypes, /\bavatar_url\b/u);
assert.doesNotMatch(sdkTypes, /\btagline\b/u);
assert.deepEqual(manifest.repository, {
  type: "git",
  url: "git+https://github.com/RelayMessenger/Relay-SDK.git",
  directory: "packages/cli",
});
assert.deepEqual(manifest.bugs, {
  url: "https://github.com/RelayMessenger/Relay-SDK/issues",
});
assert.deepEqual(source, {
  ...sourceLock.imports["packages/cli"],
  imported_at: "2026-09-01",
  canonical: "Relay-SDK",
});
console.log(`SDK v1 contract hash OK: ${actual}`);
