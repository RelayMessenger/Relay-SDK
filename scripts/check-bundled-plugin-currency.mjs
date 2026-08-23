/**
 * Refuse the state where npm serves a `@relaymessenger/cli` whose bundled
 * copy of a plugin is not the plugin npm serves as latest.
 *
 * Why this exists as its own check. The CLI does not install its plugins from
 * the registry: it ships them inside its own tarball. `packages/cli/src/install.ts`
 * installs the single OpenClaw archive bundled in `openclaw-plugin/`, and points
 * Claude Code at the marketplace tree bundled in `claude-plugin/`. Both are
 * generated from the workspace at the CLI's own pack time by
 * `packages/cli/scripts/build-claude-bundle.mjs`. Both halves are correct on
 * their own, and every existing gate passes on both. What nothing checked is
 * the JOIN: publishing a plugin does not oblige anyone to republish the CLI, so
 * a plugin release reaches no user until a CLI release carries it. That gap is
 * invisible to the release workflows because each one is internally
 * consistent — it is only visible from the registry.
 *
 * It cost a real fix two days. OpenClaw plugin 0.3.3 published
 * 2026-08-21T20:52:30Z and CLI 0.4.4 bundled it 83 seconds later, correctly.
 * Plugin 0.3.4 published 2026-08-23T00:38:47Z carrying the REL-167
 * group-mention wedge fix, and every stranger following the published install
 * page kept getting 0.3.3 — and kept hitting the wedge — because no CLI release
 * had been cut.
 *
 * The check covers every bundle, not just the one that burned us. The Claude
 * Code channel rides the same tarball under the same rules, and the trap is
 * armed for it identically; it has simply not gone off yet. `BUNDLES` is the
 * list, and a test asserts it covers every generated directory the CLI ships,
 * so adding a third bundle without covering it fails in CI.
 *
 * The assertion deliberately reads the registry rather than the working tree. A
 * tree-local check comparing a packed artifact against the workspace compares
 * the pack output with the thing it was packed from: green by construction, on
 * every input, forever. This one can fail, and it fails on exactly the state a
 * user experiences.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const CLI_PACKAGE = "@relaymessenger/cli";

function run(command, args, options = {}) {
  return execFileSync(process.platform === "win32" ? `${command}.cmd` : command, args, {
    encoding: "utf8",
    ...options,
  });
}

function extractMember(cliTarball, workDir, member) {
  try {
    run("tar", ["-xzf", cliTarball, "-C", workDir, `package/${member}`], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    // tar's own message names the member it could not find, and it is the whole
    // diagnosis when a published CLI is missing a bundle it claims to ship.
    throw new Error(
      `could not read package/${member} from the published tarball: `
      + `${String(error?.stderr ?? "").trim() || error?.message}`,
    );
  }
  return join(workDir, "package", member);
}

/**
 * The OpenClaw version is read from the bundled archive's own manifest, never
 * parsed out of its filename. A filename is a convention; the manifest is the
 * identity npm installs by, and a prerelease version puts dashes in both.
 */
function readOpenclawVersion(cliTarball, workDir) {
  const bundleDir = extractMember(cliTarball, workDir, "openclaw-plugin");
  const archives = readdirSync(bundleDir).filter((name) => name.endsWith(".tgz"));
  assert.equal(
    archives.length,
    1,
    `published ${CLI_PACKAGE} must bundle exactly one OpenClaw archive; found ${archives.length}`,
  );
  const innerDir = join(workDir, "openclaw-inner");
  mkdirSync(innerDir, { recursive: true });
  run("tar", ["-xzf", join(bundleDir, archives[0]), "-C", innerDir, "package/package.json"]);
  const manifest = JSON.parse(readFileSync(join(innerDir, "package", "package.json"), "utf8"));
  assert.equal(
    manifest.name,
    "@relaymessenger/openclaw-plugin",
    `bundled archive is ${manifest.name}, not @relaymessenger/openclaw-plugin`,
  );
  assert.ok(manifest.version, "bundled OpenClaw archive has no version");
  return manifest.version;
}

/**
 * The Claude bundle ships as a directory tree rather than an archive, so its
 * version lives in the plugin manifest Claude Code itself reads. That manifest
 * and the package version are one identity, asserted equal on every
 * relay-claude-channel release by `scripts/claude-channel-release.mjs`, which is
 * what makes the manifest a sound thing to compare against the registry.
 */
function readClaudeChannelVersion(cliTarball, workDir) {
  const manifestPath = extractMember(
    cliTarball,
    workDir,
    "claude-plugin/marketplace/plugins/relay/.claude-plugin/plugin.json",
  );
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.ok(manifest.version, "bundled Claude plugin manifest has no version");
  return manifest.version;
}

/**
 * Every package the CLI tarball carries a copy of. `root` is the directory in
 * `packages/cli`'s `files` list that carries it, and the coverage test uses it
 * to prove this list is complete.
 */
export const BUNDLES = [
  {
    package: "@relaymessenger/openclaw-plugin",
    root: "openclaw-plugin",
    releaseTagPrefix: "openclaw-v",
    readBundledVersion: readOpenclawVersion,
  },
  {
    package: "relay-claude-channel",
    root: "claude-plugin",
    releaseTagPrefix: "claude-channel-v",
    readBundledVersion: readClaudeChannelVersion,
  },
];

/**
 * Orders two release versions for the REPAIR MESSAGE only, never for the
 * verdict. Returns -1/0/1, and 0 for anything it cannot order confidently —
 * including any prerelease, whose precedence rules are not worth reimplementing
 * to pick a sentence.
 */
export function compareReleaseOrder(left, right) {
  const parse = (value) => /^(\d+)\.(\d+)\.(\d+)$/u.exec(value);
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return 0;
  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(a[index]) - Number(b[index]);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * The comparison, isolated from every registry and filesystem read so it can be
 * tested against inputs the registry cannot be made to produce on demand.
 *
 * Equality, not "bundled is at least latest", because both directions are
 * defects with different repairs and the operator needs to be told which one
 * they have.
 */
export function compareBundleCurrency({ bundle, bundled, latest }) {
  assert.ok(bundle?.package, "bundle descriptor is required");
  assert.ok(bundled, `bundled ${bundle?.package} version is required`);
  assert.ok(latest, `latest ${bundle?.package} version is required`);
  if (bundled === latest) {
    return {
      ok: true,
      package: bundle.package,
      bundled,
      latest,
      message: `${CLI_PACKAGE} bundles ${bundle.package}@${bundled}, matching the published latest`,
    };
  }
  // Any inequality is the defect, and that verdict is decided by equality
  // alone — never by ordering, so no semver edge case can turn a real drift
  // into a pass. Ordering is used only to choose which repair to print, and
  // when the two cannot be ordered the operator is told both facts plainly
  // rather than being sent to the wrong one.
  const direction = compareReleaseOrder(bundled, latest);
  const preamble =
    `${CLI_PACKAGE} on npm bundles ${bundle.package}@${bundled}, but ${bundle.package} latest is ${latest}. `
    + "The CLI installs only its own bundled copy, so this is what users actually get. ";
  let repair;
  if (direction < 0) {
    repair =
      "The CLI is behind: bump packages/cli/package.json and its package-lock.json mirror, "
      + "merge, and tag relaymessenger-v<new version>.";
  } else if (direction > 0) {
    repair =
      `The CLI is ahead, so the ${bundle.package} release is the missing one: `
      + `tag ${bundle.releaseTagPrefix}${bundled}.`;
  } else {
    repair =
      "These two versions cannot be ordered, so release both deliberately rather than guessing "
      + "which is newer.";
  }
  return { ok: false, package: bundle.package, bundled, latest, message: preamble + repair };
}

/**
 * A registry that cannot be read is an UNKNOWN state, not a passing one. The
 * caller exits on its own code so a network failure can never be mistaken for
 * "the versions agree" — the failure mode that would make this check
 * decorative.
 */
function readRegistry(workDir, bundles) {
  run("npm", ["pack", `${CLI_PACKAGE}@latest`, "--silent", "--pack-destination", workDir], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const packed = readdirSync(workDir).filter((name) => name.endsWith(".tgz"));
  assert.equal(packed.length, 1, `expected one packed ${CLI_PACKAGE} tarball, found ${packed.length}`);
  const latest = new Map();
  for (const bundle of bundles) {
    latest.set(
      bundle.package,
      run("npm", ["view", `${bundle.package}@latest`, "version"], {
        stdio: ["ignore", "pipe", "pipe"],
      }).trim(),
    );
  }
  return { cliTarball: join(workDir, packed[0]), latest };
}

function evaluate(workDir) {
  let registry;
  try {
    registry = readRegistry(workDir, BUNDLES);
  } catch (error) {
    process.stderr.write(`could not read registry state: ${error?.message ?? error}\n`);
    process.stderr.write("this is UNKNOWN, not a pass; re-run once the registry is reachable\n");
    return 2;
  }
  // Past this line every failure is a defect in what was published, not an
  // unknown: a tarball missing a bundle it claims to ship is exactly as broken
  // as a stale one, so it exits 1 and says what is wrong.
  let ok = true;
  for (const bundle of BUNDLES) {
    let result;
    try {
      result = compareBundleCurrency({
        bundle,
        bundled: bundle.readBundledVersion(registry.cliTarball, workDir),
        latest: registry.latest.get(bundle.package),
      });
    } catch (error) {
      process.stdout.write(
        `${CLI_PACKAGE} on npm does not carry a readable ${bundle.package}: ${error?.message ?? error}\n`,
      );
      ok = false;
      continue;
    }
    process.stdout.write(`${result.message}\n`);
    ok = ok && result.ok;
  }
  return ok ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const workDir = mkdtempSync(join(tmpdir(), "bundled-plugin-currency-"));
  let code;
  try {
    code = evaluate(workDir);
  } finally {
    // process.exit skips finally blocks, so the temp tree is removed before the
    // exit rather than in one.
    rmSync(workDir, { recursive: true, force: true });
  }
  process.exit(code);
}
