#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const raw = (repository, commit, path) => {
  const parsed = new URL(repository);
  return `https://raw.githubusercontent.com${parsed.pathname}/${commit}/${path}`;
};

export async function verifyContractLock(lock, fetchSource = fetch) {
  // The private server commit records origin; installed users read the
  // byte-identical public contract pinned in the same lock.
  const publicSource = lock.api.public_source;
  assert.equal(publicSource?.repository, "https://github.com/RelayMessenger/Relay-SDK");
  assert.ok(publicSource.commit && publicSource.path, "public contract pin is required");
  for (const [repository, commit, path, expected] of [
    [publicSource.repository, publicSource.commit, publicSource.path, lock.api.openapi_sha256],
    [lock.docs.repository, lock.docs.commit, lock.docs.skill_path, lock.docs.skill_sha256],
    [lock.sdk.repository, lock.sdk.commit, lock.sdk.package_path, lock.sdk.package_sha256],
  ]) {
    const response = await fetchSource(raw(repository, commit, path), {
      signal: AbortSignal.timeout(30_000),
    });
    assert.equal(response.status, 200, `${path} could not be fetched`);
    assert.equal(digest(Buffer.from(await response.arrayBuffer())), expected, path);
  }

  const registry = await fetchSource("https://registry.npmjs.org/@relaymessenger%2Fsdk", {
    signal: AbortSignal.timeout(30_000),
  });
  assert.equal(registry.status, 200);
  const metadata = await registry.json();
  // A retained lock pins an immutable version, not a movable release tag.
  const published = metadata.versions?.[lock.sdk.version];
  assert.ok(published, `locked SDK ${lock.sdk.version} is not published`);
  assert.equal(published.dist?.integrity, lock.sdk.integrity, "locked SDK integrity drifted");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const lock = JSON.parse(
    await readFile(new URL("../RELAY_V1_LOCK.json", import.meta.url), "utf8"),
  );
  await verifyContractLock(lock);
  console.log(
    `verified Relay v1 lock at Server ${lock.api.commit}, Docs ${lock.docs.commit}, and SDK ${lock.sdk.version}`,
  );
}
