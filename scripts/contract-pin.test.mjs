import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { contractTag, pinReachability } from "./contract-pin.mjs";

const sha256 = "f1d3f19b12e068ad68b95b41650b62af6f921ec263e37dd2d24f59a72903ce30";
const git = (root, ...args) => {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
const commit = (root, text) => {
  writeFileSync(join(root, "contract.yaml"), text);
  git(root, "add", "contract.yaml");
  git(root, "commit", "-q", "-m", text);
  return git(root, "rev-parse", "HEAD");
};

test("a pin reachable only from a branch that was squash-merged away fails, naming the tag to push", (t) => {
  const root = mkdtempSync(join(tmpdir(), "relay-contract-pin-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q", "-b", "main");
  const merged = commit(root, "merged");
  git(root, "update-ref", "refs/remotes/origin/main", merged);
  git(root, "checkout", "-q", "-b", "pr");
  const branchOnly = commit(root, "pr-only");

  const durable = pinReachability({ root, commit: merged, sha256 });
  assert.deepEqual({ checked: durable.checked, reachable: durable.reachable, from: durable.from }, { checked: true, reachable: true, from: ["refs/remotes/origin/main"] });

  const stranded = pinReachability({ root, commit: branchOnly, sha256 });
  assert.equal(stranded.checked, true);
  assert.equal(stranded.reachable, false);
  assert.match(stranded.message, new RegExp(`push the tag ${contractTag(sha256)} at it`));
  assert.equal(contractTag(sha256), "contract/f1d3f19b");

  // The tag is what makes a squashed-away commit durable.
  git(root, "tag", contractTag(sha256), branchOnly);
  const tagged = pinReachability({ root, commit: branchOnly, sha256 });
  assert.deepEqual({ reachable: tagged.reachable, from: tagged.from }, { reachable: true, from: [`refs/tags/${contractTag(sha256)}`] });
});

test("a checkout with no remote refs and no tag says the check was skipped instead of failing", (t) => {
  const root = mkdtempSync(join(tmpdir(), "relay-contract-pin-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q", "-b", "main");
  const only = commit(root, "only");
  const result = pinReachability({ root, commit: only, sha256 });
  assert.equal(result.checked, false);
  assert.match(result.message, /was not checked/);
});
