#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const provenance = JSON.parse(
  readFileSync(join(root, ".relay-source.json"), "utf8"),
);
assert.match(provenance.source_commit, /^[0-9a-f]{40}$/);
assert.equal(
  provenance.source_repository,
  "https://github.com/RelayMessenger/Relay-SDK",
);
assert.equal(provenance.source_branch, "staging");

let source = process.env.RELAY_SDK_SOURCE_DIR?.trim();
let expectedBranchRef;
if (source) {
  source = resolve(source);
  const branchRefs = [
    `refs/heads/${provenance.source_branch}`,
    `refs/remotes/origin/${provenance.source_branch}`,
  ];
  expectedBranchRef = branchRefs.find((ref) => {
    try {
      execFileSync("git", ["-C", source, "rev-parse", "--verify", ref], {
        stdio: "ignore",
      });
      return true;
    } catch {
      return false;
    }
  });
  assert.ok(
    expectedBranchRef,
    `source checkout lacks ${provenance.source_branch} branch provenance`,
  );
} else {
  source = mkdtempSync(join(tmpdir(), "relay-sdk-source-"));
  execFileSync("git", ["init", "--quiet", source]);
  execFileSync("git", [
    "-C",
    source,
    "remote",
    "add",
    "origin",
    `${provenance.source_repository}.git`,
  ]);
  execFileSync("git", [
    "-C",
    source,
    "fetch",
    "--quiet",
    "--depth",
    "1",
    "origin",
    `refs/heads/${provenance.source_branch}:refs/remotes/origin/${provenance.source_branch}`,
  ]);
  expectedBranchRef = `refs/remotes/origin/${provenance.source_branch}`;
  execFileSync("git", [
    "-C",
    source,
    "checkout",
    "--quiet",
    "--detach",
    expectedBranchRef,
  ]);
}

const actualCommit = execFileSync(
  "git",
  ["-C", source, "rev-parse", "HEAD"],
  { encoding: "utf8" },
).trim();
assert.equal(actualCommit, provenance.source_commit);
const branchCommit = execFileSync(
  "git",
  ["-C", source, "rev-parse", expectedBranchRef],
  { encoding: "utf8" },
).trim();
assert.equal(
  branchCommit,
  provenance.source_commit,
  `${provenance.source_commit} is not the exact ${provenance.source_branch} head`,
);

for (const [path, expected] of Object.entries(provenance.source_files)) {
  const actual = createHash("sha256")
    .update(readFileSync(join(source, path)))
    .digest("hex");
  assert.equal(actual, expected, `source file changed: ${path}`);
}

console.log(
  `verified ${provenance.distribution} source bytes at ${actualCommit}`,
);
