import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertHeadCarriesTag,
  requireTaggedHead,
  tagsPointingAtHead,
} from "./release-tag-contract.mjs";

test("a sibling package's tag on the same commit is not a mismatch", () => {
  const together = ["relaymessenger-v0.4.0", "sdk-v0.2.0", "vercel-ai-v0.2.0"];
  for (const tag of together) assertHeadCarriesTag(together, tag);
});

test("a commit missing this package's tag is refused, and the message names what it does carry", () => {
  assert.throws(
    () => assertHeadCarriesTag(["relaymessenger-v0.4.0"], "vercel-ai-v0.2.0"),
    /checked-out commit is tagged relaymessenger-v0\.4\.0, not vercel-ai-v0\.2\.0/u,
  );
  assert.throws(() => assertHeadCarriesTag([], "sdk-v0.2.0"), /tagged \(nothing\), not sdk-v0\.2\.0/u);
});

test("a near-miss tag name never satisfies the contract", () => {
  assert.throws(() => assertHeadCarriesTag(["sdk-v0.2.10"], "sdk-v0.2.1"), /not sdk-v0\.2\.1/u);
});

/**
 * The pure predicate above cannot catch a wrong git invocation, which is the
 * half that actually broke. Drive real git over a commit carrying three tags.
 */
test("real git reports every tag on the released commit", () => {
  const repo = mkdtempSync(join(tmpdir(), "release-tag-contract-"));
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  try {
    git("init", "--quiet", "--initial-branch=main");
    git("config", "user.email", "release-test@relayapp.im");
    git("config", "user.name", "release test");
    writeFileSync(join(repo, "package.json"), '{"name":"fixture"}\n');
    git("add", "package.json");
    git("commit", "--quiet", "-m", "release fixture");
    const together = ["relaymessenger-v0.4.0", "sdk-v0.2.0", "vercel-ai-v0.2.0"];
    for (const tag of together) git("tag", tag);

    assert.deepEqual(tagsPointingAtHead(repo).sort(), [...together].sort());
    for (const tag of together) requireTaggedHead(repo, tag);
    assert.throws(() => requireTaggedHead(repo, "chat-sdk-v0.1.0"), /not chat-sdk-v0\.1\.0/u);

    // An untagged commit must still be refused rather than read as tagged.
    writeFileSync(join(repo, "package.json"), '{"name":"fixture","version":"0.0.1"}\n');
    git("commit", "--quiet", "-am", "untagged follow-up");
    assert.deepEqual(tagsPointingAtHead(repo), []);
    assert.throws(() => requireTaggedHead(repo, "sdk-v0.2.0"), /tagged \(nothing\)/u);
  } finally {
    rmSync(repo, { force: true, recursive: true });
  }
});
