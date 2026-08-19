import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

/** Every tag name on the checked-out commit, in git's own order. */
export function tagsPointingAtHead(repoRoot) {
  return execFileSync("git", ["tag", "--points-at", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * Packages released together share one commit, so a sibling package's tag on
 * the same commit is not a mismatch. `git describe --exact-match` reports only
 * ONE of those tags, which failed two of the three releases cut from 339a8ca
 * (sdk-v0.2.0 and vercel-ai-v0.2.0 both lost to relaymessenger-v0.4.0). Assert
 * membership instead: this package's own tag must be among them.
 */
export function assertHeadCarriesTag(tags, tag) {
  assert.ok(
    tags.includes(tag),
    `checked-out commit is tagged ${tags.join(", ") || "(nothing)"}, not ${tag}`,
  );
}

/** Refuse a release whose checked-out commit does not carry its own tag. */
export function requireTaggedHead(repoRoot, tag) {
  assertHeadCarriesTag(tagsPointingAtHead(repoRoot), tag);
}
