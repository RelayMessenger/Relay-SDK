// Lands the release's cookbook pins on staging, the way the staging bump
// lands its version commit (publish-package-staging.yml, `land`).
//
// main is staging's exact tree and only a pull request from staging changes
// it (the "Protect main" ruleset requires the `validate` check on every commit
// main takes, and a commit made here has none). After release-run.mjs has
// published, the cookbooks' Relay pins it derived (rewriteCookbooks in
// release-derive.mjs) are committed on top of staging, so the next promotion
// carries release pins into main and a folder copied out of GitHub installs a
// release, not a staging build.
//
// It lands only onto the cookbook tree the release was cut from: when staging
// has changed a cookbook since, it lands nothing and says so, and the next
// release derives again. A push made with GITHUB_TOKEN starts no workflow run.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join, relative } from "node:path";

export const LAND_MESSAGE = `release: pin the cookbooks to the published releases

scripts/release-run.mjs published the Relay packages as latest and rewrote
every cookbook's Relay staging pins to the versions it published
(rewriteCookbooks in scripts/release-derive.mjs), then proved the folders on
the release channel. This commit carries those pins to staging so the next
promotion takes them into main.`;

function git(root, args, { env = {}, allowFailure = false } = {}) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  if (!allowFailure) {
    assert.equal(result.status, 0, `git ${args[0]} failed: ${result.stderr}`);
  }
  return result;
}

/**
 * `paths` are the absolute files rewriteCookbooks wrote under `root`.
 * `remote` is the repository URL; `auth` (optional) is an HTTP Authorization
 * header value, passed through git's environment config, never an argument.
 * Returns { landed, sha?, reason? }.
 */
export function landCookbookPins({ root, paths, remote, auth = null, say = () => {} }) {
  if (paths.length === 0) return { landed: false, reason: "no cookbook pin changed" };
  const authEnv = auth
    ? { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraheader", GIT_CONFIG_VALUE_0: `AUTHORIZATION: ${auth}` }
    : {};
  git(root, ["fetch", "--no-tags", "--quiet", remote, "refs/heads/staging"], { env: authEnv });
  const staging = git(root, ["rev-parse", "FETCH_HEAD"]).stdout.trim();
  const releasedCookbooks = git(root, ["rev-parse", "HEAD:cookbook"]).stdout.trim();
  const stagingCookbooks = git(root, ["rev-parse", `${staging}:cookbook`]).stdout.trim();
  if (releasedCookbooks !== stagingCookbooks) {
    return { landed: false, reason: `staging ${staging.slice(0, 12)} changed a cookbook since this release; the next release derives again` };
  }
  const scratch = join(root, ".release-tmp", "land");
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });
  const index = { GIT_INDEX_FILE: join(scratch, "index") };
  try {
    git(root, ["read-tree", staging], { env: index });
    for (const path of paths) {
      const name = relative(root, path).split("\\").join("/");
      assert.ok(name.startsWith("cookbook/"), `${name} is not a cookbook file`);
      const [mode] = git(root, ["ls-tree", staging, "--", name]).stdout.trim().split(/\s+/u);
      assert.ok(mode, `${name} is not tracked on staging`);
      const blob = git(root, ["hash-object", "-w", "--", path]).stdout.trim();
      git(root, ["update-index", "--cacheinfo", `${mode},${blob},${name}`], { env: index });
    }
    const tree = git(root, ["write-tree"], { env: index }).stdout.trim();
    const identity = {
      GIT_AUTHOR_NAME: "github-actions[bot]",
      GIT_AUTHOR_EMAIL: "41898282+github-actions[bot]@users.noreply.github.com",
      GIT_COMMITTER_NAME: "github-actions[bot]",
      GIT_COMMITTER_EMAIL: "41898282+github-actions[bot]@users.noreply.github.com",
    };
    const sha = git(root, ["commit-tree", tree, "-p", staging, "-m", LAND_MESSAGE], { env: identity }).stdout.trim();
    // A plain push: the remote takes it only while staging is still `staging`.
    git(root, ["push", "--quiet", remote, `${sha}:refs/heads/staging`], { env: authEnv });
    say(`landed ${sha} on staging: ${paths.map((path) => relative(root, path)).join(", ")}`);
    return { landed: true, sha };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
