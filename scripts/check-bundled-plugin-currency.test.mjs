import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  BUNDLES,
  CLI_PACKAGE,
  compareBundleCurrency,
  compareReleaseOrder,
} from "./check-bundled-plugin-currency.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundleFor = (name) => {
  const bundle = BUNDLES.find((candidate) => candidate.package === name);
  assert.ok(bundle, `no bundle descriptor for ${name}`);
  return bundle;
};
const OPENCLAW = bundleFor("@relaymessenger/openclaw-plugin");
const CLAUDE = bundleFor("relay-claude-channel");

test("agreeing versions pass", () => {
  const result = compareBundleCurrency({ bundle: OPENCLAW, bundled: "0.3.4", latest: "0.3.4" });
  assert.equal(result.ok, true);
  assert.match(result.message, /0\.3\.4/u);
});

// The exact state that shipped the REL-167 wedge fix to nobody for two days.
test("a CLI bundling an older plugin than npm serves is refused", () => {
  const result = compareBundleCurrency({ bundle: OPENCLAW, bundled: "0.3.3", latest: "0.3.4" });
  assert.equal(result.ok, false);
  // Both versions must appear or the operator cannot tell what they are looking at.
  assert.match(result.message, /0\.3\.3/u);
  assert.match(result.message, /0\.3\.4/u);
  // Exactly one repair, and it must be the CLI one. Printing both repairs is
  // what the first draft of this check did, and "tag openclaw-v0.3.3" beside a
  // stale 0.3.3 reads as an instruction to re-release the old plugin.
  assert.match(result.message, /relaymessenger-v/u);
  assert.doesNotMatch(result.message, /openclaw-v/u);
});

test("a CLI bundling a plugin npm has never published is refused too", () => {
  const result = compareBundleCurrency({ bundle: OPENCLAW, bundled: "0.4.0", latest: "0.3.4" });
  assert.equal(result.ok, false);
  // The other direction names the other repair: the plugin release is missing.
  assert.match(result.message, /openclaw-v0\.4\.0/u);
  assert.doesNotMatch(result.message, /relaymessenger-v/u);
});

// The Claude bundle is the untested half of the same trap, and it has its own
// tag series. A repair naming the OpenClaw tag here would send the operator to
// the wrong release lane.
test("the Claude bundle names its own repairs, not the OpenClaw ones", () => {
  const behind = compareBundleCurrency({ bundle: CLAUDE, bundled: "0.2.1", latest: "0.2.2" });
  assert.equal(behind.ok, false);
  assert.match(behind.message, /relay-claude-channel@0\.2\.1/u);
  assert.match(behind.message, /relaymessenger-v/u);
  assert.doesNotMatch(behind.message, /claude-channel-v/u);

  const ahead = compareBundleCurrency({ bundle: CLAUDE, bundled: "0.3.0", latest: "0.2.1" });
  assert.equal(ahead.ok, false);
  assert.match(ahead.message, /claude-channel-v0\.3\.0/u);
  assert.doesNotMatch(ahead.message, /openclaw-v/u);
  assert.doesNotMatch(ahead.message, /relaymessenger-v/u);
});

test("versions that cannot be ordered still fail, and say so instead of guessing", () => {
  const result = compareBundleCurrency({
    bundle: OPENCLAW,
    bundled: "0.3.4",
    latest: "0.3.5-beta.1",
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /cannot be ordered/u);
  assert.doesNotMatch(result.message, /relaymessenger-v/u);
  assert.doesNotMatch(result.message, /openclaw-v/u);
});

test("release ordering decides only the message, and abstains on prereleases", () => {
  assert.equal(compareReleaseOrder("0.3.3", "0.3.4"), -1);
  assert.equal(compareReleaseOrder("0.4.0", "0.3.4"), 1);
  assert.equal(compareReleaseOrder("1.0.0", "0.9.9"), 1);
  assert.equal(compareReleaseOrder("0.3.4", "0.3.4"), 0);
  // Two-digit segments must compare numerically, not lexically.
  assert.equal(compareReleaseOrder("0.9.0", "0.10.0"), -1);
  // Abstention, not a wrong guess.
  assert.equal(compareReleaseOrder("0.3.4", "0.3.5-beta.1"), 0);
});

test("an unreadable version is an error, never a quiet pass", () => {
  assert.throws(() => compareBundleCurrency({ bundle: OPENCLAW, bundled: "", latest: "0.3.4" }));
  assert.throws(() =>
    compareBundleCurrency({ bundle: OPENCLAW, bundled: "0.3.4", latest: undefined }),
  );
});

/**
 * Builds a CLI tarball shaped like the real one. The OpenClaw archive's
 * FILENAME deliberately disagrees with its manifest version: a check that
 * parsed the filename would read that number and pass only by accident, so this
 * pins the manifest as the source of identity.
 */
function buildFixtureTarball(root, { openclaw, claude } = {}) {
  const outer = join(root, "outer", "package");
  if (openclaw) {
    const inner = join(root, "inner", "package");
    mkdirSync(inner, { recursive: true });
    writeFileSync(
      join(inner, "package.json"),
      `${JSON.stringify({ name: "@relaymessenger/openclaw-plugin", version: openclaw.manifestVersion }, null, 2)}\n`,
    );
    const bundleDir = join(outer, "openclaw-plugin");
    mkdirSync(bundleDir, { recursive: true });
    execFileSync("tar", [
      "-czf",
      join(bundleDir, openclaw.archiveFilename),
      "-C",
      join(root, "inner"),
      "package",
    ]);
  }
  if (claude) {
    const manifestDir = join(outer, "claude-plugin/marketplace/plugins/relay/.claude-plugin");
    mkdirSync(manifestDir, { recursive: true });
    writeFileSync(
      join(manifestDir, "plugin.json"),
      `${JSON.stringify({ name: "relay", version: claude.manifestVersion }, null, 2)}\n`,
    );
  }
  mkdirSync(outer, { recursive: true });
  const tarball = join(root, "cli.tgz");
  execFileSync("tar", ["-czf", tarball, "-C", join(root, "outer"), "package"]);
  return tarball;
}

function withFixture(label, body) {
  const root = mkdtempSync(join(tmpdir(), `bundled-plugin-currency-${label}-`));
  const workDir = join(root, "work");
  mkdirSync(workDir, { recursive: true });
  try {
    body(root, workDir);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("the bundled OpenClaw version is read from the archive manifest, not its filename", () => {
  withFixture("filename", (root, workDir) => {
    const tarball = buildFixtureTarball(root, {
      openclaw: {
        manifestVersion: "0.3.4",
        archiveFilename: "relaymessenger-openclaw-plugin-9.9.9.tgz",
      },
    });
    assert.equal(OPENCLAW.readBundledVersion(tarball, workDir), "0.3.4");
  });
});

test("the bundled Claude version is read from the manifest Claude Code itself reads", () => {
  withFixture("claude", (root, workDir) => {
    const tarball = buildFixtureTarball(root, { claude: { manifestVersion: "0.2.1" } });
    assert.equal(CLAUDE.readBundledVersion(tarball, workDir), "0.2.1");
  });
});

test("a CLI tarball bundling no OpenClaw archive is refused rather than skipped", () => {
  withFixture("empty", (root, workDir) => {
    const bundleDir = join(root, "outer", "package", "openclaw-plugin");
    mkdirSync(bundleDir, { recursive: true });
    // tar needs a file to keep the directory, and it must not end in .tgz.
    writeFileSync(join(bundleDir, "README"), "no archive here\n");
    const tarball = join(root, "cli.tgz");
    execFileSync("tar", ["-czf", tarball, "-C", join(root, "outer"), "package"]);
    assert.throws(
      () => OPENCLAW.readBundledVersion(tarball, workDir),
      /must bundle exactly one OpenClaw archive/u,
    );
  });
});

test("a CLI tarball missing the Claude manifest is refused rather than skipped", () => {
  withFixture("no-claude", (root, workDir) => {
    const tarball = buildFixtureTarball(root, {
      openclaw: { manifestVersion: "0.3.4", archiveFilename: "plugin-0.3.4.tgz" },
    });
    // The failure has to name the missing member, or the operator learns only
    // that something went wrong inside a tarball they cannot see.
    assert.throws(() => CLAUDE.readBundledVersion(tarball, workDir), /plugin\.json/u);
  });
});

/**
 * The coverage assertion, and the reason this file exists as more than a unit
 * test. The OpenClaw drift was found by a user hitting a wedge, not by anyone
 * reasoning about release coupling, and the same trap is armed for every other
 * directory the CLI bundles. So the list of covered bundles is checked against
 * the CLI's own `files` list: adding a third generated bundle without covering
 * it here fails in CI instead of waiting for the next wedge.
 */
test("every bundle the CLI ships is covered", () => {
  const cliPkg = JSON.parse(
    readFileSync(join(repoRoot, "packages/cli/package.json"), "utf8"),
  );
  // Everything in `files` that is not one of these is a bundled copy of another
  // package. `dist` is the CLI's own build output, and the two files are its
  // paperwork; none of them has a separate npm identity that can outpace it.
  const notBundles = new Set(["dist", "LICENSE", "README.md"]);
  const shipped = cliPkg.files.filter((entry) => !notBundles.has(entry)).sort();
  const covered = BUNDLES.map((bundle) => bundle.root).sort();
  assert.deepEqual(
    shipped,
    covered,
    `packages/cli ships ${shipped.join(", ")} but this check covers ${covered.join(", ")}`,
  );
});

test("the packages it compares are the ones the installer actually uses", () => {
  assert.equal(CLI_PACKAGE, "@relaymessenger/cli");
  assert.deepEqual(
    BUNDLES.map((bundle) => bundle.package).sort(),
    ["@relaymessenger/openclaw-plugin", "relay-claude-channel"],
  );
});

/**
 * Reads the tag a release lane will actually accept, out of that lane's own
 * script. Asserting the prefixes against literals here would only prove this
 * file agrees with itself; the failure that matters is a repair message telling
 * someone to push a tag no workflow answers, which is exactly the mistake this
 * lane nearly made by assuming the CLI series was `cli-v`.
 */
function tagPrefixFrom(script) {
  const source = readFileSync(join(repoRoot, "scripts", script), "utf8");
  const match = /const expectedTag = `([^`$]*)\$\{pkg\.version\}`/u.exec(source);
  assert.ok(match, `${script} no longer declares expectedTag in a readable shape`);
  return match[1];
}

test("every repair names a tag its release lane will accept", () => {
  assert.equal(OPENCLAW.releaseTagPrefix, tagPrefixFrom("openclaw-release.mjs"));
  assert.equal(CLAUDE.releaseTagPrefix, tagPrefixFrom("claude-channel-release.mjs"));
  // The CLI repair is the one every "behind" message prints, so its tag grammar
  // is pinned to the CLI lane's own script the same way.
  const cliPrefix = tagPrefixFrom("cli-release.mjs");
  const behind = compareBundleCurrency({ bundle: OPENCLAW, bundled: "0.3.3", latest: "0.3.4" });
  assert.match(behind.message, new RegExp(`tag ${cliPrefix}`, "u"));
});
