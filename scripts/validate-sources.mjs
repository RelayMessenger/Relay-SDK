import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const lock = JSON.parse(
  await readFile(join(root, "sources.lock.json"), "utf8"),
);

assert.equal(lock.schema_version, 1);
assert.equal(
  lock.canonical_repository,
  "https://github.com/RelayMessenger/Relay-SDK",
);

for (const [path, expected] of Object.entries(lock.imports)) {
  assert.match(expected.commit, /^[0-9a-f]{40}$/);
  const source = JSON.parse(
    await readFile(join(root, path, "SOURCE.json"), "utf8"),
  );
  assert.deepEqual(source, {
    repository: expected.repository,
    commit: expected.commit,
    imported_at: "2026-09-01",
    canonical: "Relay-SDK",
  }, `${path}/SOURCE.json drifted from sources.lock.json`);
}

console.log(
  `validated ${Object.keys(lock.imports).length} exact imported source roots`,
);
