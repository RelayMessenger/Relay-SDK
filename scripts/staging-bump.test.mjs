import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readManifests } from "./release-derive.mjs";
import { releaseKeys, releasePackages } from "./release-packages.mjs";
import {
  applyPins,
  applyVersion,
  differingFiles,
  nextVersion,
  parseStagingVersion,
  tarballFileHashes,
} from "./staging-bump.mjs";

const never = () => false;

test("parses X.Y.Z-staging.N and refuses every other shape", () => {
  assert.deepEqual(parseStagingVersion("0.3.0-staging.9"), {
    base: "0.3.0", major: 0, minor: 3, patch: 0, prerelease: 9,
  });
  for (const bad of ["0.3.0", "0.3.0-rc.1", "0.3.0-staging", "0.3.0-staging.x", "", undefined]) {
    assert.throws(() => parseStagingVersion(bad), /is not an X\.Y\.Z-staging\.N version/u, String(bad));
  }
});

test("published prerelease with unchanged content ships nothing", () => {
  for (const basePublished of [false, true]) {
    const decision = nextVersion({
      version: "0.3.0-staging.9",
      versionPublished: true,
      basePublished,
      contentChanged: false,
      isPublished: never,
    });
    assert.equal(decision.action, "none");
    assert.equal(decision.version, "0.3.0-staging.9");
  }
});

test("changed content under an unpublished base increments the prerelease", () => {
  const decision = nextVersion({
    version: "0.4.0-staging.5",
    versionPublished: true,
    basePublished: false,
    contentChanged: true,
    isPublished: never,
  });
  assert.deepEqual([decision.action, decision.version], ["bump", "0.4.0-staging.6"]);
});

test("changed content under a published base bumps patch and resets to staging.0", () => {
  // The concrete case of 2026-09-07: relay-claude-channel@0.3.0-staging.6 on
  // npm, PR 129 changed its carried contract, and 0.3.0 is already latest.
  const decision = nextVersion({
    version: "0.3.0-staging.6",
    versionPublished: true,
    basePublished: true,
    contentChanged: true,
    isPublished: never,
  });
  assert.deepEqual([decision.action, decision.version], ["bump", "0.3.1-staging.0"]);
});

test("an unpublished prerelease of an unpublished base is kept as the tree names it", () => {
  const decision = nextVersion({
    version: "0.3.1-staging.0",
    versionPublished: false,
    basePublished: false,
    contentChanged: null,
    isPublished: never,
  });
  assert.deepEqual([decision.action, decision.version], ["keep", "0.3.1-staging.0"]);
});

test("an unpublished prerelease of a published base still moves the base", () => {
  // Otherwise main derives 0.3.0, finds it on npm, and skips the package forever.
  const decision = nextVersion({
    version: "0.3.0-staging.10",
    versionPublished: false,
    basePublished: true,
    contentChanged: null,
    isPublished: never,
  });
  assert.deepEqual([decision.action, decision.version], ["bump", "0.3.1-staging.0"]);
});

test("a candidate npm already holds is skipped", () => {
  const taken = new Set(["0.3.1-staging.0", "0.3.1-staging.1"]);
  const decision = nextVersion({
    version: "0.3.0-staging.6",
    versionPublished: true,
    basePublished: true,
    contentChanged: true,
    isPublished: (candidate) => taken.has(candidate),
  });
  assert.equal(decision.version, "0.3.1-staging.2");
  const incremented = nextVersion({
    version: "0.4.0-staging.5",
    versionPublished: true,
    basePublished: false,
    contentChanged: true,
    isPublished: (candidate) => candidate === "0.4.0-staging.6",
  });
  assert.equal(incremented.version, "0.4.0-staging.7");
});

test("differing files lists changed, added, and removed paths", () => {
  const left = { "package/a.js": "1", "package/b.js": "2", "package/gone.js": "3" };
  const right = { "package/a.js": "1", "package/b.js": "9", "package/new.js": "4" };
  assert.deepEqual(differingFiles(left, right), ["package/b.js", "package/gone.js", "package/new.js"]);
  assert.deepEqual(differingFiles(left, { ...left }), []);
});

test("hashes every file of a tarball through the injected tar", () => {
  const files = { "package/package.json": "{}", "package/dist/index.js": "x" };
  const tar = (args) => {
    if (args[0] === "-tzf") return `${Object.keys(files).join("\n")}\npackage/dist/\n`;
    return Buffer.from(files[args[2]]);
  };
  const hashes = tarballFileHashes("ignored.tgz", tar);
  assert.deepEqual(Object.keys(hashes).sort(), Object.keys(files).sort());
  assert.match(hashes["package/dist/index.js"], /^[0-9a-f]{64}$/u);
  assert.notEqual(hashes["package/dist/index.js"], hashes["package/package.json"]);
});

function fixtureTree() {
  const temp = mkdtempSync(join(tmpdir(), "staging-bump-"));
  for (const key of releaseKeys) {
    const directory = join(temp, releasePackages[key].directory);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "package.json"), JSON.stringify({
      name: releasePackages[key].workspace,
      version: "0.9.0-staging.3",
      dependencies: key === "sdk" ? {} : { "@relaymessenger/sdk": "0.3.0-staging.8", ws: "^8.0.0" },
    }));
  }
  const lock = {
    relaySdk: { package: "@relaymessenger/sdk", version: "0.3.0-staging.8", integrity: "sha512-old" },
  };
  for (const relative of [
    "packages/openclaw/contracts/relay-v1.lock.json",
    "packages/claude-code/contracts/relay-v1.lock.json",
    "packages/claude-code/plugin/contracts/relay-v1.lock.json",
  ]) {
    mkdirSync(join(temp, relative, ".."), { recursive: true });
    writeFileSync(join(temp, relative), JSON.stringify(lock));
  }
  for (const relative of [
    "packages/claude-code/.claude-plugin/plugin.json",
    "packages/claude-code/plugin/.claude-plugin/plugin.json",
  ]) {
    mkdirSync(join(temp, relative, ".."), { recursive: true });
    writeFileSync(join(temp, relative), JSON.stringify({ name: "relay", version: "0.9.0-staging.3" }));
  }
  writeFileSync(
    join(temp, "packages/claude-code/.claude-plugin/marketplace.json"),
    JSON.stringify({ plugins: [{ name: "relay", version: "0.9.0-staging.3" }] }),
  );
  return temp;
}

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

test("pins a dependent to the decided SDK and carries version plus integrity into its locks", () => {
  const temp = fixtureTree();
  const manifests = readManifests(temp);
  const decided = { sdk: { version: "0.9.1-staging.0", integrity: "sha512-new", action: "bump" } };
  const dry = applyPins(temp, "openclaw", manifests, decided, { write: false });
  assert.deepEqual(dry, ["package.json", "contracts/relay-v1.lock.json"]);
  assert.equal(readJson(join(temp, "packages/openclaw/package.json")).dependencies["@relaymessenger/sdk"], "0.3.0-staging.8");
  const written = applyPins(temp, "openclaw", manifests, decided, { write: true });
  assert.deepEqual(written, dry);
  const manifest = readJson(join(temp, "packages/openclaw/package.json"));
  assert.equal(manifest.dependencies["@relaymessenger/sdk"], "0.9.1-staging.0");
  assert.equal(manifest.dependencies.ws, "^8.0.0");
  assert.deepEqual(readJson(join(temp, "packages/openclaw/contracts/relay-v1.lock.json")).relaySdk, {
    package: "@relaymessenger/sdk", version: "0.9.1-staging.0", integrity: "sha512-new",
  });
  // Already pinned: nothing to change.
  assert.deepEqual(applyPins(temp, "openclaw", manifests, decided, { write: true }), []);
  // The SDK depends on nothing and has no lock; a package without an SDK decision is untouched.
  assert.deepEqual(applyPins(temp, "sdk", manifests, decided, { write: true }), []);
  assert.deepEqual(applyPins(temp, "cli", manifests, {}, { write: true }), []);
});

test("writes the version into package.json and every claude-code carrier", () => {
  const temp = fixtureTree();
  assert.deepEqual(applyVersion(temp, "cli", "0.9.0-staging.4"), ["package.json"]);
  assert.equal(readJson(join(temp, "packages/cli/package.json")).version, "0.9.0-staging.4");
  const written = applyVersion(temp, "claude-code", "0.9.1-staging.0");
  assert.deepEqual(written, [
    "package.json",
    ".claude-plugin/plugin.json",
    "plugin/.claude-plugin/plugin.json",
    ".claude-plugin/marketplace.json",
  ]);
  for (const relative of written.slice(0, 3)) {
    assert.equal(readJson(join(temp, "packages/claude-code", relative)).version, "0.9.1-staging.0");
  }
  assert.equal(
    readJson(join(temp, "packages/claude-code/.claude-plugin/marketplace.json")).plugins[0].version,
    "0.9.1-staging.0",
  );
  // Siblings keep their version.
  assert.equal(readJson(join(temp, "packages/mcp/package.json")).version, "0.9.0-staging.3");
});
