import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  historicalImportDigest, HISTORICAL_IMPORTS_SHA256, verifyImportInventory,
} from "./import-inventory.mjs";

const { entries } = JSON.parse(readFileSync(
  new URL("../sources.import-manifest.json", import.meta.url), "utf8",
));
const originalPaths = entries.map((entry) => entry.destination);

test("new tracked canonical code is not mislabeled as an upstream import", () => {
  const newPath = "packages/cli/src/new-canonical-feature.ts";
  const paths = [...originalPaths, newPath];
  assert.deepEqual(verifyImportInventory(entries, paths, new Set(paths)), [newPath]);
  assert.equal(historicalImportDigest(entries), HISTORICAL_IMPORTS_SHA256);
});

test("changing or dropping historical source evidence still fails", () => {
  const mutated = structuredClone(entries);
  mutated[0].source_sha256 = "0".repeat(64);
  for (const bad of [mutated, entries.slice(1)]) {
    assert.throws(
      () => verifyImportInventory(bad, originalPaths, new Set(originalPaths)),
      /historical import sources or inventory changed/,
    );
  }
});

test("missing historical files and untracked additions are not waved through", () => {
  assert.throws(
    () => verifyImportInventory(entries, originalPaths.slice(1), new Set(originalPaths)),
    /historical imported destination is missing/,
  );
  assert.throws(
    () => verifyImportInventory(entries, [...originalPaths, "packages/cli/private.env"], new Set(originalPaths)),
    /new canonical source must be tracked/,
  );
});

test("updating current destination bytes does not rewrite historical provenance", () => {
  const edited = structuredClone(entries);
  edited[0].destination_sha256 = "1".repeat(64);
  edited[0].status = "canonicalized";
  assert.equal(historicalImportDigest(edited), HISTORICAL_IMPORTS_SHA256);
});
