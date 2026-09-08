import assert from "node:assert/strict";
import { createHash } from "node:crypto";

// Immutable source-side records from staging 10950ef40bf254beee4a9289eedd9c7fc897c41c.
// Current destination hashes may change as the monorepo evolves. Newly authored
// files are not historical imports and must not acquire invented upstream origins.
//
// This digest moves only when a record is removed with its file. It last moved
// on 2026-09-08, when the npm registry receipts for @relaymessenger/sdk
// 0.3.0-staging.4 and 0.3.0-staging.8 were deleted: they described versions
// nothing depends on any more, and stale evidence is deleted, never rewritten.
// No surviving record's repository, commit, source path, bytes or mode changed.
export const HISTORICAL_IMPORTS_SHA256 =
  "edba75059a7428305706d62955a9b855bde97cc6aa91a179da732329c9957897";

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
