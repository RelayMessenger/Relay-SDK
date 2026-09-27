// The release lands its cookbook pins on staging only onto the cookbook tree
// it was cut from, as one commit on top of staging, and never touches main.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LAND_MESSAGE, landCookbookPins } from "./release-cookbook-land.mjs";

const identity = {
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
};
function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...identity } });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

// A remote whose staging and main hold the same cookbook, and a release
// checkout of main whose tree carries the rewritten pin.
function fixture() {
  const base = mkdtempSync(join(tmpdir(), "release-land-"));
  const remote = join(base, "remote.git");
  const seed = join(base, "seed");
  git(base, "init", "-q", "--bare", "-b", "staging", remote);
  mkdirSync(join(seed, "cookbook/think"), { recursive: true });
  git(seed, "init", "-q", "-b", "staging");
  writeFileSync(join(seed, "cookbook/think/package.json"), '{"dependencies":{"@relaymessenger/sdk":"0.3.6-staging.46"}}\n');
  writeFileSync(join(seed, "README.md"), "staging\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "seed");
  git(seed, "push", "-q", remote, "staging", "staging:main");
  const release = join(base, "release");
  git(base, "clone", "-q", "-b", "main", remote, release);
  const pin = join(release, "cookbook/think/package.json");
  writeFileSync(pin, '{"dependencies":{"@relaymessenger/sdk":"0.3.6"}}\n');
  return { remote, seed, release, pin };
}

test("lands the rewritten pins as one commit on top of staging", () => {
  const { remote, release, pin } = fixture();
  const before = git(release, "--git-dir", remote, "rev-parse", "staging");
  const main = git(release, "--git-dir", remote, "rev-parse", "main");
  const result = landCookbookPins({ root: release, paths: [pin], remote });
  assert.equal(result.landed, true);
  assert.equal(git(release, "--git-dir", remote, "rev-parse", "staging"), result.sha);
  assert.equal(git(release, "--git-dir", remote, "rev-parse", `${result.sha}^`), before);
  assert.equal(git(release, "--git-dir", remote, "rev-parse", "main"), main);
  assert.equal(git(release, "--git-dir", remote, "diff", "--name-only", before, result.sha), "cookbook/think/package.json");
  assert.equal(git(release, "--git-dir", remote, "show", `${result.sha}:cookbook/think/package.json`),
    '{"dependencies":{"@relaymessenger/sdk":"0.3.6"}}');
  assert.equal(git(release, "--git-dir", remote, "log", "-1", "--format=%B", result.sha), LAND_MESSAGE);
  assert.equal(git(release, "status", "--porcelain"), "M cookbook/think/package.json");
});

test("lands nothing when staging changed a cookbook since the release", () => {
  const { remote, seed, release, pin } = fixture();
  writeFileSync(join(seed, "cookbook/think/package.json"), '{"dependencies":{"@relaymessenger/sdk":"0.3.6-staging.47"}}\n');
  git(seed, "commit", "-q", "-am", "newer staging pin");
  git(seed, "push", "-q", remote, "staging");
  const staging = git(release, "--git-dir", remote, "rev-parse", "staging");
  const result = landCookbookPins({ root: release, paths: [pin], remote });
  assert.equal(result.landed, false);
  assert.match(result.reason, /changed a cookbook since this release/u);
  assert.equal(git(release, "--git-dir", remote, "rev-parse", "staging"), staging);
});

test("lands nothing when no pin changed, and never a file outside cookbook/", () => {
  const { remote, release } = fixture();
  assert.deepEqual(landCookbookPins({ root: release, paths: [], remote }), { landed: false, reason: "no cookbook pin changed" });
  assert.throws(() => landCookbookPins({ root: release, paths: [join(release, "README.md")], remote }), /is not a cookbook file/u);
});
