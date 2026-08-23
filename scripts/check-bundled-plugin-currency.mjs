/**
 * Refuse the state where npm serves a `@relaymessenger/cli` whose bundled
 * OpenClaw plugin is not the plugin npm serves as latest.
 *
 * Why this exists as its own check. The CLI does not install the plugin from
 * the registry: `packages/cli/src/install.ts` installs the single archive
 * bundled inside the CLI tarball (`plugins install npm-pack:<archive>`), and
 * that archive is packed from the workspace at the CLI's own pack time. Both
 * halves are correct on their own, and every existing gate passes on both.
 * What nothing checked is the JOIN: publishing the plugin does not oblige
 * anyone to republish the CLI, so a plugin release reaches no user until a CLI
 * release carries it. That gap is invisible to the release workflows because
 * each one is internally consistent — it is only visible from the registry.
 *
 * It cost a real fix two days. Plugin 0.3.3 published 2026-08-21T20:52:30Z and
 * CLI 0.4.4 bundled it 83 seconds later, correctly. Plugin 0.3.4 published
 * 2026-08-23T00:38:47Z carrying the REL-167 group-mention wedge fix, and every
 * stranger following the published install page kept getting 0.3.3 — and kept
 * hitting the wedge — because no CLI release had been cut.
 *
 * So the assertion deliberately reads the registry rather than the working
 * tree. A tree-local check comparing the packed archive against the workspace
 * plugin compares the pack output with the thing it was packed from: green by
 * construction, on every input, forever. This one can fail, and it fails on
 * exactly the state a user experiences.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const CLI_PACKAGE = "@relaymessenger/cli";
export const PLUGIN_PACKAGE = "@relaymessenger/openclaw-plugin";

/**
 * The comparison, isolated from every registry and filesystem read so it can
 * be tested against inputs the registry cannot be made to produce on demand.
 *
 * Equality, not "bundled is at least latest", because both directions are
 * defects with different repairs and the operator needs to be told which one
 * they have.
 */
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

export function comparePluginCurrency({ bundled, latest }) {
  assert.ok(bundled, "bundled plugin version is required");
  assert.ok(latest, "latest plugin version is required");
  if (bundled === latest) {
    return {
      ok: true,
      bundled,
      latest,
      message: `${CLI_PACKAGE} bundles ${PLUGIN_PACKAGE}@${bundled}, matching the published latest`,
    };
  }
  // Any inequality is the defect, and that verdict is decided by equality
  // alone — never by ordering, so no semver edge case can turn a real drift
  // into a pass. Ordering is used only to choose which repair to print, and
  // when the two cannot be ordered the operator is told both facts plainly
  // rather than being sent to the wrong one.
  const direction = compareReleaseOrder(bundled, latest);
  const preamble =
    `${CLI_PACKAGE} on npm bundles ${PLUGIN_PACKAGE}@${bundled}, but ${PLUGIN_PACKAGE} latest is ${latest}. `
    + "The CLI installs only its bundled archive, so this is what users actually get. ";
  let repair;
  if (direction < 0) {
    repair =
      "The CLI is behind: bump packages/cli/package.json and its package-lock.json mirror, "
      + "merge, and tag relaymessenger-v<new version>.";
  } else if (direction > 0) {
    repair =
      `The CLI is ahead, so the plugin release is the missing one: tag openclaw-v${bundled}.`;
  } else {
    repair =
      "These two versions cannot be ordered, so release both deliberately rather than guessing "
      + "which is newer.";
  }
  return { ok: false, bundled, latest, message: preamble + repair };
}

function run(command, args, options = {}) {
  return execFileSync(process.platform === "win32" ? `${command}.cmd` : command, args, {
    encoding: "utf8",
    ...options,
  });
}

/**
 * The version is read from the bundled archive's own manifest, never parsed out
 * of its filename. A filename is a convention; the manifest is the identity npm
 * installs by, and a prerelease version puts dashes in both.
 */
export function bundledPluginVersionFromTarball(cliTarball, workDir) {
  run("tar", ["-xzf", cliTarball, "-C", workDir, "package/openclaw-plugin"]);
  const bundleDir = join(workDir, "package", "openclaw-plugin");
  const archives = readdirSync(bundleDir).filter((name) => name.endsWith(".tgz"));
  assert.equal(
    archives.length,
    1,
    `published ${CLI_PACKAGE} must bundle exactly one OpenClaw archive; found ${archives.length}`,
  );
  const innerDir = join(workDir, "inner");
  run("mkdir", ["-p", innerDir]);
  run("tar", ["-xzf", join(bundleDir, archives[0]), "-C", innerDir, "package/package.json"]);
  const manifest = JSON.parse(readFileSync(join(innerDir, "package", "package.json"), "utf8"));
  assert.equal(manifest.name, PLUGIN_PACKAGE, `bundled archive is ${manifest.name}, not ${PLUGIN_PACKAGE}`);
  return manifest.version;
}

/**
 * A registry that cannot be read is an UNKNOWN state, not a passing one. It
 * exits non-zero on its own code so a network failure can never be mistaken
 * for "the versions agree" — the failure mode that would make this check
 * decorative.
 */
function readRegistry() {
  const workDir = mkdtempSync(join(tmpdir(), "bundled-plugin-currency-"));
  try {
    run("npm", ["pack", `${CLI_PACKAGE}@latest`, "--silent", "--pack-destination", workDir], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const packed = readdirSync(workDir).filter((name) => name.endsWith(".tgz"));
    assert.equal(packed.length, 1, `expected one packed ${CLI_PACKAGE} tarball, found ${packed.length}`);
    const bundled = bundledPluginVersionFromTarball(join(workDir, packed[0]), workDir);
    const latest = run("npm", ["view", `${PLUGIN_PACKAGE}@latest`, "version"], {
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return { bundled, latest };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let state;
  try {
    state = readRegistry();
  } catch (error) {
    process.stderr.write(`could not read registry state: ${error?.message ?? error}\n`);
    process.stderr.write("this is UNKNOWN, not a pass; re-run once the registry is reachable\n");
    process.exit(2);
  }
  const result = comparePluginCurrency(state);
  process.stdout.write(`${result.message}\n`);
  process.exit(result.ok ? 0 : 1);
}
