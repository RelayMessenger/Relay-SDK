// Refresh only the current destination side of the historical import receipt.
// Source repositories, commits, paths, bytes and modes remain immutable and
// are still independently retrieved and verified by verify-import-provenance.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function syncImportMetadata(root, { write = false } = {}) {
  const path = join(root, "sources.import-manifest.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(manifest.schema_version, 1);
  for (const entry of manifest.entries) {
    const destination = resolve(root, entry.destination);
    assert.ok(destination.startsWith(`${resolve(root)}/`), "destination escapes repository");
    const stat = lstatSync(destination);
    assert.ok(stat.isFile(), `${entry.destination} is not a regular file`);
    const digest = createHash("sha256").update(readFileSync(destination)).digest("hex");
    const mode = stat.mode & 0o111 ? "100755" : "100644";
    const expected = {
      destination_sha256: digest,
      destination_mode: mode,
      status: digest === entry.source_sha256 && mode === entry.source_mode ? "exact" : "canonicalized",
    };
    if (write) Object.assign(entry, expected);
    else for (const [key, value] of Object.entries(expected)) {
      assert.equal(entry[key], value, `${entry.destination}: ${key} drifted; run npm run metadata:sync`);
    }
  }
  if (write) writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  assert.ok(["--write", "--check"].includes(process.argv[2]), "pass --write or --check");
  const manifest = syncImportMetadata(resolve(import.meta.dirname, ".."), { write: process.argv[2] === "--write" });
  console.log(`verified ${manifest.entries.length} current import destinations; historical sources unchanged`);
}
