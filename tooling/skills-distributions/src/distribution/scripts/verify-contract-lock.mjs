#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const lock = JSON.parse(
  await readFile(new URL("../RELAY_V1_LOCK.json", import.meta.url), "utf8"),
);

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const raw = (repository, commit, path) => {
  const parsed = new URL(repository);
  return `https://raw.githubusercontent.com${parsed.pathname}/${commit}/${path}`;
};

for (const [repository, commit, path, expected] of [
  [
    lock.api.repository,
    lock.api.commit,
    lock.api.openapi_path,
    lock.api.openapi_sha256,
  ],
  [
    lock.api.repository,
    lock.api.commit,
    lock.api.skill_path,
    lock.api.skill_sha256,
  ],
  [
    lock.sdk.repository,
    lock.sdk.commit,
    lock.sdk.package_path,
    lock.sdk.package_sha256,
  ],
]) {
  const response = await fetch(raw(repository, commit, path), {
    signal: AbortSignal.timeout(30_000),
  });
  assert.equal(response.status, 200, `${path} could not be fetched`);
  assert.equal(digest(Buffer.from(await response.arrayBuffer())), expected, path);
}

const registry = await fetch(
  "https://registry.npmjs.org/@relaymessenger%2Fsdk",
  { signal: AbortSignal.timeout(30_000) },
);
assert.equal(registry.status, 200);
const metadata = await registry.json();
assert.equal(metadata["dist-tags"][lock.sdk.dist_tag], lock.sdk.version);
assert.ok(metadata.versions[lock.sdk.version]);

console.log(
  `verified Relay v1 lock at Docs ${lock.api.commit} and SDK ${lock.sdk.version}`,
);
