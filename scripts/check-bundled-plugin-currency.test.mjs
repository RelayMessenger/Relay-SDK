import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  bundledPluginVersionFromTarball,
  CLI_PACKAGE,
  comparePluginCurrency,
  compareReleaseOrder,
  PLUGIN_PACKAGE,
} from "./check-bundled-plugin-currency.mjs";

test("agreeing versions pass", () => {
  const result = comparePluginCurrency({ bundled: "0.3.4", latest: "0.3.4" });
  assert.equal(result.ok, true);
  assert.match(result.message, /0\.3\.4/u);
});

// The exact state that shipped the REL-167 wedge fix to nobody for two days.
test("a CLI bundling an older plugin than npm serves is refused", () => {
  const result = comparePluginCurrency({ bundled: "0.3.3", latest: "0.3.4" });
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
  const result = comparePluginCurrency({ bundled: "0.4.0", latest: "0.3.4" });
  assert.equal(result.ok, false);
  // The other direction names the other repair: the plugin release is missing.
  assert.match(result.message, /openclaw-v0\.4\.0/u);
  assert.doesNotMatch(result.message, /relaymessenger-v/u);
});

test("versions that cannot be ordered still fail, and say so instead of guessing", () => {
  const result = comparePluginCurrency({ bundled: "0.3.4", latest: "0.3.5-beta.1" });
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
  assert.throws(() => comparePluginCurrency({ bundled: "", latest: "0.3.4" }));
  assert.throws(() => comparePluginCurrency({ bundled: "0.3.4", latest: undefined }));
});

/**
 * Builds a CLI tarball shaped like the real one, with the bundled archive's
 * FILENAME deliberately disagreeing with its manifest version. A check that
 * parsed the filename would read 9.9.9 and pass this test only by accident, so
 * this pins the manifest as the source of identity.
 */
function buildFixtureTarball(root, { manifestVersion, archiveFilename }) {
  const inner = join(root, "inner", "package");
  mkdirSync(inner, { recursive: true });
  writeFileSync(
    join(inner, "package.json"),
    `${JSON.stringify({ name: PLUGIN_PACKAGE, version: manifestVersion }, null, 2)}\n`,
  );
  const outerBundle = join(root, "outer", "package", "openclaw-plugin");
  mkdirSync(outerBundle, { recursive: true });
  execFileSync("tar", ["-czf", join(outerBundle, archiveFilename), "-C", join(root, "inner"), "package"]);
  const tarball = join(root, "cli.tgz");
  execFileSync("tar", ["-czf", tarball, "-C", join(root, "outer"), "package"]);
  return tarball;
}

test("the bundled version is read from the archive manifest, not its filename", () => {
  const root = mkdtempSync(join(tmpdir(), "bundled-plugin-currency-test-"));
  try {
    const tarball = buildFixtureTarball(root, {
      manifestVersion: "0.3.4",
      archiveFilename: "relaymessenger-openclaw-plugin-9.9.9.tgz",
    });
    const workDir = join(root, "work");
    mkdirSync(workDir, { recursive: true });
    assert.equal(bundledPluginVersionFromTarball(tarball, workDir), "0.3.4");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a CLI tarball bundling no archive is refused rather than skipped", () => {
  const root = mkdtempSync(join(tmpdir(), "bundled-plugin-currency-empty-"));
  try {
    mkdirSync(join(root, "outer", "package", "openclaw-plugin"), { recursive: true });
    // tar needs a file to keep the directory, and it must not end in .tgz.
    writeFileSync(join(root, "outer", "package", "openclaw-plugin", "README"), "no archive here\n");
    const tarball = join(root, "cli.tgz");
    execFileSync("tar", ["-czf", tarball, "-C", join(root, "outer"), "package"]);
    const workDir = join(root, "work");
    mkdirSync(workDir, { recursive: true });
    assert.throws(
      () => bundledPluginVersionFromTarball(tarball, workDir),
      /must bundle exactly one OpenClaw archive/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the packages it compares are the ones the installer actually uses", () => {
  assert.equal(CLI_PACKAGE, "@relaymessenger/cli");
  assert.equal(PLUGIN_PACKAGE, "@relaymessenger/openclaw-plugin");
});
