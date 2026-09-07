import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const lock = JSON.parse(readFileSync(join(root, "sources.lock.json"), "utf8"));
const manifest = JSON.parse(
  readFileSync(join(root, "sources.import-manifest.json"), "utf8"),
);
assert.equal(manifest.schema_version, 1);

const sha256 = (value) =>
  createHash("sha256").update(value).digest("hex");
const bytes = (path) => readFileSync(path);
const mode = (path) => (lstatSync(path).mode & 0o111 ? "100755" : "100644");

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (
      entry.isDirectory()
      && [
        ".artifacts",
        ".release",
        ".release-tmp",
        ".wrangler",
        "coverage",
        "dist",
        "node_modules",
      ].includes(entry.name)
    ) {
      return [];
    }
    if (entry.isDirectory()) return walk(path);
    if (entry.isFile() && entry.name !== "SOURCE.json") return [path];
    return [];
  });
}

const destinations = Object.keys(lock.imports).flatMap((directory) =>
  walk(join(root, directory)).map((path) => relative(root, path))
).sort();
const manifested = manifest.entries.map((entry) => entry.destination).sort();
assert.deepEqual(
  destinations,
  manifested,
  "imported destination inventory drifted from the historical manifest",
);

for (const entry of manifest.entries) {
  assert.match(entry.commit, /^[0-9a-f]{40}$/u);
  assert.ok(["exact", "canonicalized"].includes(entry.status));
  const destination = join(root, entry.destination);
  assert.equal(sha256(bytes(destination)), entry.destination_sha256);
  assert.equal(mode(destination), entry.destination_mode);
  if (entry.status === "exact") {
    assert.equal(entry.source_sha256, entry.destination_sha256);
    assert.equal(entry.source_mode, entry.destination_mode);
  } else {
    assert.notEqual(
      entry.source_sha256,
      entry.destination_sha256,
      `${entry.destination} no longer requires canonicalization`,
    );
  }
}

const temporary = mkdtempSync(join(tmpdir(), "relay-import-provenance-"));
const checkouts = new Map();
try {
  for (const entry of manifest.entries) {
    const key = `${entry.repository}@${entry.commit}`;
    if (checkouts.has(key)) continue;
    const checkout = join(temporary, sha256(Buffer.from(key)).slice(0, 16));
    const archive = `${checkout}.tgz`;
    mkdirSync(checkout, { recursive: true });
    const url =
      `https://api.github.com/repos/${entry.repository}/tarball/${entry.commit}`;
    let response;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      response = await fetch(url, {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "Relay-SDK-Import-Provenance/1.0",
        },
        signal: AbortSignal.timeout(60_000),
      });
      if (response.ok) break;
      if (attempt < 2 && response.status >= 500) {
        await new Promise((resolveDelay) =>
          setTimeout(resolveDelay, 500 * (attempt + 1))
        );
        continue;
      }
      break;
    }
    assert.equal(
      response?.status,
      200,
      `could not retrieve ${key}: HTTP ${response?.status}`,
    );
    writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
    const extracted = spawnSync(
      "tar",
      ["-xzf", archive, "-C", checkout, "--strip-components=1"],
      { encoding: "utf8" },
    );
    assert.equal(
      extracted.status,
      0,
      `could not extract ${key}: ${extracted.stderr}`,
    );
    checkouts.set(key, checkout);
  }

  for (const entry of manifest.entries) {
    const key = `${entry.repository}@${entry.commit}`;
    const source = join(checkouts.get(key), entry.source);
    assert.equal(
      sha256(bytes(source)),
      entry.source_sha256,
      `${key}:${entry.source} changed or was not the recorded source`,
    );
    assert.equal(mode(source), entry.source_mode);
  }
} finally {
  rmSync(temporary, { recursive: true, force: true, maxRetries: 10 });
}

const exact = manifest.entries.filter((entry) => entry.status === "exact").length;
const canonicalized = manifest.entries.length - exact;
console.log(
  `verified ${manifest.entries.length} historical imports from `
    + `${checkouts.size} immutable GitHub commits: `
    + `${exact} exact and ${canonicalized} explicitly canonicalized`,
);
