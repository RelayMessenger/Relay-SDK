import assert from "node:assert/strict";
import { createHash } from "node:crypto";

// Immutable source-side records from staging 10950ef40bf254beee4a9289eedd9c7fc897c41c.
// Current destination hashes may change as the monorepo evolves. Newly authored
// files are not historical imports and must not acquire invented upstream origins.
export const HISTORICAL_IMPORTS_SHA256 =
  "2925809751da0d9157a312de903467426ec8c6113c62fb9eac3f690bb3c3c50a";

export function historicalImportDigest(entries) {
  const records = entries.map(({
    destination, repository, commit, source, source_sha256, source_mode,
  }) => ({ destination, repository, commit, source, source_sha256, source_mode }))
    .sort((a, b) => a.destination < b.destination ? -1 : a.destination > b.destination ? 1 : 0);
  return createHash("sha256").update(JSON.stringify(records)).digest("hex");
}

export function verifyImportInventory(entries, destinations, trackedPaths) {
  assert.equal(
    historicalImportDigest(entries),
    HISTORICAL_IMPORTS_SHA256,
    "historical import sources or inventory changed; do not rewrite upstream provenance",
  );
  const actual = new Set(destinations);
  const historical = new Set(entries.map((entry) => entry.destination));
  assert.equal(historical.size, entries.length, "duplicate historical import destination");
  for (const path of historical) {
    assert.ok(actual.has(path), `${path}: historical imported destination is missing`);
  }
  const additions = destinations.filter((path) => !historical.has(path)).sort();
  for (const path of additions) {
    assert.ok(trackedPaths.has(path), `${path}: new canonical source must be tracked, not an unexplained workspace artifact`);
  }
  return additions;
}
