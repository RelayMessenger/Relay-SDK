// Proves every cookbook folder is a self-contained project a developer can
// copy out of GitHub and run with `npm install && npm start`, with nothing but
// an Agent Token: against production on main, against staging on staging.
//
//   node scripts/validate-cookbook-standalone.mjs               copy, install, type-check
//   node scripts/validate-cookbook-standalone.mjs --link-check  workspace-side checks only
//   ... --only webhook-receiver                                  one folder
//   ... --channel staging|release                                name the channel outside CI
//   ... --tarball <path.tgz> (repeatable)                        release builds npm does not have yet
//
// Two properties, checked from two sides:
//
// 1. Standalone (default mode, network): each folder is copied to a temp dir
//    OUTSIDE the workspace, `npm install` runs against the real registry, the
//    installed Relay packages are builds of the branch's own channel, and
//    `tsc --noEmit` runs from the folder's OWN devDependencies. The workspace
//    is never installed here, so nothing can leak in from it.
//
//    The channel follows the branch, as the two publish flows do: a push to
//    staging publishes X.Y.Z-staging.N under the `staging` dist-tag
//    (scripts/publish-package-staging.mjs), a push to main publishes the plain
//    X.Y.Z as `latest` (scripts/release-run.mjs). CI names the branch in
//    GITHUB_REF (refs/heads/<branch>) on a push and in GITHUB_BASE_REF (the
//    branch a pull request merges into) on a pull request.
//
//    release (main, and every branch that is not staging): every installed
//      Relay package is a release, never a prerelease; a folder without a
//      lockfile installs the newest one, npm's `latest`.
//    staging: a folder without a lockfile installs npm's `staging` dist-tag,
//      the newest staging build. A folder with a lockfile installs what it
//      pins, which may be a release or a staging build (X.Y.Z-staging.N), never
//      another prerelease.
//
// 2. Workspace (--link-check, no network): every Relay dependency a cookbook
//    declares resolves to the workspace package (packages/<name>), so the
//    monorepo's own CI validates the cookbooks against the tree, not against
//    whatever the registry has. Every tsconfig stays inside its folder, and
//    the tools its scripts run are its own devDependencies.
//
// 3. The release (scripts/release-run.mjs) rewrites every cookbook's Relay
//    staging pins to the versions it publishes (rewriteCookbooks in
//    release-derive.mjs) and then runs this check on the release channel.
//    Before the publish, in the dry run, those versions exist only as the
//    tarballs it packed: `--tarball` adds each one to a private npm cache and
//    every install prefers that cache, so the lockfile's registry URL and
//    integrity resolve to the exact bytes the release will publish.
//
//    On the release channel, a folder that pins a Relay package to an exact
//    staging build (X.Y.Z-staging.N) cannot install a release until the
//    release job has run: that pin is what the release rewrites. Without
//    `--tarball`, this check names such a folder and leaves it to the
//    release, which proves it in `release-dry-run` (ci.yml, the same run,
//    from the packed tarballs) before the merge and in release.yml after the
//    publish, both through `--tarball` or npm itself.
//
// A semver prerelease range covers only its own X.Y.Z tuple. The automatic
// bump can move to the next tuple before its plain release exists. Root
// postinstall therefore links unpinned cookbook Relay dependencies explicitly
// (scripts/link-cookbook-workspaces.mjs); standalone copies retain their
// registry ranges and do not inherit that root-only lifecycle script.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { releasePackages } from "./release-packages.mjs";

const root = resolve(import.meta.dirname, "..");
const cookbookRoot = join(root, "cookbook");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const say = (message) => process.stdout.write(`${message}\n`);

const workspaceByName = new Map(
  Object.values(releasePackages).map((entry) => [entry.workspace, entry.directory]),
);

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

// A folder that ships its own package-lock.json and a `test:installed` script
// pins exact published versions by contract (cloudflare-think-agent locks the
// adapter tarball's integrity in test/contracts.test.ts), so it can never
// resolve the workspace prerelease: the workspace-link rule below does not
// apply to it. Its `npm ci` from that lockfile in a temp copy, then its full
// test suite, runs under `npm run validate:cookbook`. The standalone check
// still applies: a copied folder must install its channel's builds from npm
// and type-check on its own (measured passing on 2026-09-07 once it pinned
// sdk 0.3.0 and chat-sdk-adapter 0.3.0).
function selfProving(name) {
  const directory = join(cookbookRoot, name);
  return existsSync(join(directory, "package-lock.json"))
    && Boolean(readJson(join(directory, "package.json")).scripts?.["test:installed"]);
}

/** The npm dist-tag each channel installs from. */
export const CHANNEL_TAGS = Object.freeze({ release: "latest", staging: "staging" });

/**
 * The channel a copied cookbook installs from: `--channel` when given,
 * otherwise the branch CI names. A pull request's GITHUB_REF is
 * refs/pull/<n>/merge, so its base branch, GITHUB_BASE_REF, decides; a push
 * leaves GITHUB_BASE_REF empty and names its branch in GITHUB_REF. Only
 * staging selects the staging channel; main, every other branch, and a run
 * with no branch at all keep the release channel.
 */
export function standaloneChannel(env = process.env, argv = process.argv) {
  const index = argv.indexOf("--channel");
  if (index !== -1) {
    const named = argv[index + 1];
    assert.ok(Object.hasOwn(CHANNEL_TAGS, named), `--channel takes ${Object.keys(CHANNEL_TAGS).join(" or ")}, not ${named}`);
    return { channel: named, reason: `--channel ${named}` };
  }
  if (env.GITHUB_BASE_REF) {
    return {
      channel: env.GITHUB_BASE_REF === "staging" ? "staging" : "release",
      reason: `GITHUB_BASE_REF=${env.GITHUB_BASE_REF}`,
    };
  }
  const ref = env.GITHUB_REF ?? "";
  return {
    channel: ref === "refs/heads/staging" ? "staging" : "release",
    reason: ref ? `GITHUB_REF=${ref}` : "no branch named",
  };
}

const STAGING_BUILD = /^\d+\.\d+\.\d+-staging\.\d+$/u;

/**
 * On the release channel, the Relay dependencies a folder pins to an exact
 * staging build. Only the release can turn those into installable releases
 * (scripts/release-run.mjs), so the check leaves such a folder to it unless
 * the release's own tarballs were handed in.
 */
export function releaseDeferredPins({ channel, dependencies, tarballs }) {
  if (channel !== "release" || tarballs.length > 0) return [];
  return dependencies.filter(({ range }) => STAGING_BUILD.test(range));
}

/** Every `--tarball <path>` argument, resolved. */
export function tarballArguments(argv) {
  const found = [];
  argv.forEach((value, index) => {
    if (value === "--tarball") {
      const path = argv[index + 1];
      assert.ok(path && path.endsWith(".tgz"), `--tarball takes a .tgz path, not ${path}`);
      found.push(resolve(path));
    }
  });
  return found;
}

/**
 * Why an installed Relay package does not belong to the channel, or null.
 * `tagged` is the version npm's dist-tag for the channel names; it binds
 * only a folder without a lockfile, which installs the newest build.
 */
export function installedMismatch({ channel, dependency, installed, locked, tagged }) {
  const { name, range } = dependency;
  if (channel === "release") {
    if (/-/u.test(installed)) return `installed ${name}@${installed}, a prerelease, from range ${range}`;
    if (!locked && installed !== tagged) return `installed ${name}@${installed}; npm latest is ${tagged}`;
    return null;
  }
  assert.equal(channel, "staging");
  if (locked) {
    return /-/u.test(installed) && !STAGING_BUILD.test(installed)
      ? `installed ${name}@${installed}, a prerelease that is not a staging build, from range ${range}`
      : null;
  }
  if (!STAGING_BUILD.test(installed)) return `installed ${name}@${installed}, not a staging build, from the staging dist-tag`;
  if (installed !== tagged) return `installed ${name}@${installed}; npm staging is ${tagged}`;
  return null;
}

// Every dependency field npm installs from.
const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

function relayDependencies(manifest) {
  const found = [];
  for (const field of DEPENDENCY_FIELDS) {
    for (const [name, range] of Object.entries(manifest[field] ?? {})) {
      if (workspaceByName.has(name)) found.push({ field, name, range });
    }
  }
  return found;
}

function linkCheck(name) {
  const directory = join(cookbookRoot, name);
  const manifest = readJson(join(directory, "package.json"));
  const resolveFrom = createRequire(pathToFileURL(join(directory, "package.json")));

  // 2a. Every Relay dependency resolves to the workspace package.
  const relay = relayDependencies(manifest);
  assert.ok(relay.length > 0, `${name} declares no Relay package dependency`);
  for (const dependency of relay) {
    assert.doesNotMatch(
      dependency.range,
      /^(?:file|workspace|link):/u,
      `${name} pins ${dependency.name} with a workspace-only protocol (${dependency.range}); a copied folder cannot install it`,
    );
    const resolved = realpathSync(resolveFrom.resolve(`${dependency.name}/package.json`));
    const expected = realpathSync(join(root, workspaceByName.get(dependency.name), "package.json"));
    assert.equal(
      resolved,
      expected,
      `${name} resolves ${dependency.name} from ${relative(root, resolved)}, not the workspace ${relative(root, expected)}; `
        + `run the root npm install lifecycle to link workspace version ${readJson(expected).version}`,
    );
    say(`  ${name}: ${dependency.name}@${dependency.range} -> workspace ${readJson(expected).version}`);
  }

  // 2b. No tsconfig reaches outside the folder.
  for (const file of readdirSync(directory).filter((entry) => /^tsconfig.*\.json$/u.test(entry))) {
    const config = readJson(join(directory, file));
    for (const target of [].concat(config.extends ?? [])) {
      assert.doesNotMatch(target, /^\.\.\//u, `${name}/${file} extends ${target}, outside the folder`);
      const resolved = resolve(directory, target);
      assert.ok(
        !relative(directory, resolved).startsWith(".."),
        `${name}/${file} extends ${target}, outside the folder`,
      );
      assert.ok(existsSync(resolved), `${name}/${file} extends ${target}, which does not exist`);
    }
  }

  // 2c. The tools its scripts run are its own devDependencies.
  const scripts = Object.values(manifest.scripts ?? {}).join("\n");
  const own = { ...manifest.dependencies, ...manifest.devDependencies };
  for (const tool of ["tsc", "tsx", "vitest", "wrangler"]) {
    if (!new RegExp(`(?:^|[\\s&|;])${tool}(?:\\s|$)`, "u").test(scripts)) continue;
    const pkg = tool === "tsc" ? "typescript" : tool;
    assert.ok(own[pkg], `${name} runs ${tool} but does not declare ${pkg} in its own devDependencies`);
  }
}

/**
 * A private npm cache holding the release tarballs npm does not have yet.
 * npm reads a locked dependency's tarball from the cache by its integrity, so
 * `--prefer-offline` installs these bytes without asking the registry for them
 * (measured 2026-09-27 on npm 12.0.2: the Think starter locked to an
 * unpublished sdk 0.3.6 installs from the seeded cache and fails E404 without
 * it).
 */
function seededCache(tarballs) {
  if (tarballs.length === 0) return null;
  const cache = mkdtempSync(join(tmpdir(), "relay-cookbook-release-cache-"));
  for (const tarball of tarballs) {
    assert.ok(existsSync(tarball), `--tarball ${tarball} does not exist`);
    run(npm, ["cache", "add", tarball, "--cache", cache], root);
  }
  return cache;
}

function run(command, args, cwd) {
  say(`  $ ${args.length ? `${command} ${args.join(" ")}` : command}`);
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, CI: "1" } });
  assert.equal(result.status, 0, `${command} ${args[0]} failed in ${cwd}`);
}

const EXCLUDED = new Set([".artifacts", ".dev.vars", ".git", ".wrangler", "coverage", "dist", "node_modules"]);

function distTag(packageName, tag) {
  const out = execFileSync(npm, ["view", packageName, `dist-tags.${tag}`, "--json", "--registry", "https://registry.npmjs.org/"], { encoding: "utf8" });
  const parsed = JSON.parse(out);
  return Array.isArray(parsed) ? parsed[0] : parsed;
}

function standaloneCheck(name, channel, taggedByName, { tarballs = [], cache = null } = {}) {
  const tag = CHANNEL_TAGS[channel];
  const source = join(cookbookRoot, name);
  const temporary = mkdtempSync(join(tmpdir(), `relay-cookbook-standalone-${name}-`));
  const copy = join(temporary, name);
  // The copy must live outside the workspace: node's resolver walks up parent
  // directories, so a copy under the repo could still find the workspace's
  // node_modules and prove nothing.
  assert.ok(relative(root, copy).startsWith(".."), `${copy} is inside the workspace`);
  try {
    cpSync(source, copy, {
      recursive: true,
      filter: (path) => !EXCLUDED.has(relative(source, path).split(/[\\/]/u)[0]),
    });
    const hasLock = existsSync(join(copy, "package-lock.json"));
    say(`  copied to ${copy}${hasLock ? " (with its own lockfile)" : ""}`);
    const manifest = readJson(join(copy, "package.json"));
    const dependencies = relayDependencies(manifest);
    const deferred = releaseDeferredPins({ channel, dependencies, tarballs });
    if (deferred.length > 0) {
      say(`  ${name}: pins ${deferred.map(({ name: dependency, range }) => `${dependency}@${range}`).join(", ")}, a staging build; `
        + "the release rewrites it to the version it publishes and proves this folder then "
        + "(release-dry-run in ci.yml from the packed tarballs, release.yml after the publish)");
      return false;
    }
    if (channel === "staging" && !hasLock) {
      // What a developer on the staging channel runs: the newest staging
      // build of each Relay package, by its dist-tag. Only the copy changes.
      for (const { field, name: dependency } of dependencies) manifest[field][dependency] = tag;
      writeFileSync(join(copy, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    }
    run(npm, ["install", "--no-audit", "--no-fund", "--ignore-scripts", ...(cache ? ["--cache", cache, "--prefer-offline"] : [])], copy);
    for (const dependency of dependencies) {
      const installed = readJson(join(copy, "node_modules", ...dependency.name.split("/"), "package.json")).version;
      let tagged;
      if (!hasLock) {
        tagged = taggedByName.get(dependency.name) ?? distTag(dependency.name, tag);
        taggedByName.set(dependency.name, tagged);
      }
      const mismatch = installedMismatch({ channel, dependency, installed, locked: hasLock, tagged });
      assert.equal(mismatch, null, `${name} ${mismatch}`);
      say(`  ${name}: ${dependency.name}@${dependency.range}${channel === "staging" && !hasLock ? ` (as ${tag})` : ""} -> registry ${installed}`);
    }
    // --no-install: tsc must come from the folder's own devDependencies.
    run(npx, ["--no-install", "tsc", "--noEmit", "-p", "tsconfig.json"], copy);
    say(`  ${name}: standalone ok`);
    return true;
  } finally {
    if (process.env.RELAY_KEEP_STANDALONE === "1") say(`  kept ${copy}`);
    else rmSync(temporary, { recursive: true, force: true });
  }
}

function main(argv) {
  const linkCheckOnly = argv.includes("--link-check");
  const onlyIndex = argv.indexOf("--only");
  const only = onlyIndex === -1 ? null : argv[onlyIndex + 1];
  const cookbooks = readdirSync(cookbookRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => existsSync(join(cookbookRoot, name, "package.json")))
    .filter((name) => only === null || name === only)
    .sort();
  assert.ok(cookbooks.length > 0, `no cookbook matches ${only ?? "*"}`);
  if (linkCheckOnly) {
    for (const name of cookbooks.filter(selfProving)) {
      say(`  ${name}: link check skipped; its lockfile pins published builds and test:installed proves it under validate:cookbook`);
    }
  }
  const checked = linkCheckOnly ? cookbooks.filter((name) => !selfProving(name)) : cookbooks;

  say(`cookbook ${linkCheckOnly ? "link check" : "standalone check"}: ${checked.join(", ")}`);
  if (linkCheckOnly) {
    for (const name of checked) linkCheck(name);
    say(`validated ${checked.length} cookbooks resolve the workspace Relay packages and stay inside their folders`);
  } else {
    // npm 10.9's arborist crashes in #loadPeerSet on these folders (measured
    // 2026-09-07 on 10.9.8); CI installs npm@11.19.1 first, so name the npm
    // that ran before any install can fail for that reason.
    say(`  npm ${execFileSync(npm, ["--version"], { encoding: "utf8" }).trim()}`);
    const { channel, reason } = standaloneChannel(process.env, argv);
    say(`  channel ${channel} (${reason}): npm dist-tag ${CHANNEL_TAGS[channel]}`);
    const taggedByName = new Map();
    const tarballs = tarballArguments(argv);
    const cache = seededCache(tarballs);
    if (cache) say(`  ${tarballs.length} release tarballs seeded into ${cache}`);
    const proven = [];
    const left = [];
    try {
      for (const name of checked) {
        say(`\n=== ${name} ===`);
        (standaloneCheck(name, channel, taggedByName, { tarballs, cache }) ? proven : left).push(name);
      }
    } finally {
      if (cache) rmSync(cache, { recursive: true, force: true });
    }
    say(`\nvalidated ${proven.length} cookbooks install from npm (${channel} channel) and type-check outside the workspace`);
    if (left.length > 0) say(`left to the release, which rewrites their staging pins: ${left.join(", ")}`);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv);
}
