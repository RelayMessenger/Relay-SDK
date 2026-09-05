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

const openapiSource = lock.api.openapi_source;
if (process.env.RELAY_OPENAPI_PATH) {
  assert.equal(digest(await readFile(process.env.RELAY_OPENAPI_PATH)), lock.api.openapi_sha256);
}
// A committed Docs snapshot may not be pushed yet. Explicit local bytes
// remain checked against the exact skill digest; absence is never ignored.
if (process.env.RELAY_SKILL_PATH) {
  assert.equal(digest(await readFile(process.env.RELAY_SKILL_PATH)), lock.api.skill_sha256);
}
for (const [repository, commit, path, expected] of [
  ...(!process.env.RELAY_OPENAPI_PATH ? [[
    openapiSource?.repository ?? lock.api.repository,
    openapiSource?.commit ?? lock.api.commit,
    openapiSource?.path ?? lock.api.openapi_path,
    lock.api.openapi_sha256,
  ]] : []),
  ...(!process.env.RELAY_SKILL_PATH ? [[
    lock.api.repository,
    lock.api.commit,
    lock.api.skill_path,
    lock.api.skill_sha256,
  ]] : []),
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
const published = metadata.versions[lock.sdk.version];
assert.ok(published, "Pinned SDK distribution is missing from the registry");
assert.equal(published.name, lock.sdk.package);
assert.equal(published.version, lock.sdk.version);
// A publication baseline pins an immutable version, not today's mutable tag.
if (lock.sdk.role !== "published_distribution_baseline") {
  assert.equal(metadata["dist-tags"][lock.sdk.dist_tag], lock.sdk.version);
}

console.log(
  `verified Relay v1 OpenAPI ${lock.api.openapi_sha256} and SDK ${lock.sdk.version}`,
);
