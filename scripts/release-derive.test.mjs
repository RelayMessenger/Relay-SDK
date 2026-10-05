import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  cookbookPrereleasePins,
  rewriteCookbook,
  rewriteCookbooks,
  deriveVersion,
  filesCarryingVersion,
  readManifests,
  releaseOrder,
  releasePlan,
  rewritePackage,
} from "./release-derive.mjs";
import { releaseKeys, releasePackages } from "./release-packages.mjs";

const root = new URL("..", import.meta.url).pathname;

test("strips the staging prerelease and passes a plain version through", () => {
  assert.equal(deriveVersion("0.3.0-staging.9"), "0.3.0");
  assert.equal(deriveVersion("12.0.7-staging.0"), "12.0.7");
  assert.equal(deriveVersion("0.3.0"), "0.3.0");
});

test("fails closed on any other version shape", () => {
  for (const bad of ["0.3.0-rc.1", "0.3", "v0.3.0", "0.3.0-staging", "0.3.0-staging.x", "", undefined]) {
    assert.throws(() => deriveVersion(bad), /cannot derive a release version/u, String(bad));
  }
});

test("the catalog order releases every Relay dependency before its dependents", () => {
  const manifests = readManifests(root);
  assert.deepEqual(releaseOrder(manifests), releaseKeys);
  assert.equal(releaseKeys[0], "sdk");
  // The reverse order must be refused: every Relay dependency would follow
  // its dependents.
  assert.throws(
    () => releaseOrder(manifests, [...releaseKeys].reverse()),
    /depends on (?:sdk|chat-sdk-adapter), which must release before it/u,
  );
});

test("plans skip for what npm already has and publish for the rest", () => {
  const manifests = readManifests(root);
  const published = new Set(["@relaymessenger/sdk@0.3.0"]);
  const plan = releasePlan(manifests, (name, version) => published.has(`${name}@${version}`));
  assert.deepEqual(plan.map((row) => row.key), releaseKeys);
  for (const row of plan) {
    assert.match(row.version, /^\d+\.\d+\.\d+$/u);
    assert.equal(row.tag, `${releasePackages[row.key].tagPrefix}${row.version}`);
  }
  const sdk = plan.find((row) => row.key === "sdk");
  if (sdk.version === "0.3.0") {
    assert.equal(sdk.action, "skip");
    assert.equal(plan.filter((row) => row.action === "skip").length, 1);
  }
  const none = releasePlan(manifests, () => false);
  assert.ok(none.every((row) => row.action === "publish"));
});

test("rewrites a package to its plain version and pins Relay dependencies to theirs", () => {
  const temp = mkdtempSync(join(tmpdir(), "release-derive-"));
  for (const key of releaseKeys) {
    const directory = join(temp, releasePackages[key].directory);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "package.json"), JSON.stringify({
      name: releasePackages[key].workspace,
      version: "0.9.0-staging.3",
      dependencies: key === "sdk" ? {} : { "@relaymessenger/sdk": "0.3.0-staging.8", ws: "^8.0.0" },
    }));
  }
  const openclaw = join(temp, "packages/openclaw");
  mkdirSync(join(openclaw, "contracts"), { recursive: true });
  writeFileSync(join(openclaw, "contracts/relay-v1.lock.json"), JSON.stringify({
    relaySdk: { package: "@relaymessenger/sdk", version: "0.3.0-staging.8", integrity: "sha512-old" },
  }));
  const plan = releasePlan(readManifests(temp), () => false);
  rewritePackage(temp, "openclaw", plan, { sdkIntegrity: "sha512-new" });
  const manifest = JSON.parse(readFileSync(join(openclaw, "package.json"), "utf8"));
  assert.equal(manifest.version, "0.9.0");
  assert.equal(manifest.dependencies["@relaymessenger/sdk"], "0.9.0");
  assert.equal(manifest.dependencies.ws, "^8.0.0");
  const lock = JSON.parse(readFileSync(join(openclaw, "contracts/relay-v1.lock.json"), "utf8"));
  assert.deepEqual(lock.relaySdk, { package: "@relaymessenger/sdk", version: "0.9.0", integrity: "sha512-new" });
  // Untouched siblings keep their staging manifest.
  const cli = JSON.parse(readFileSync(join(temp, "packages/cli/package.json"), "utf8"));
  assert.equal(cli.version, "0.9.0-staging.3");
});

test("lists every shipped file that still carries the pre-rewrite version", () => {
  const temp = mkdtempSync(join(tmpdir(), "release-carriers-"));
  mkdirSync(join(temp, "runtime"), { recursive: true });
  mkdirSync(join(temp, "node_modules/dep"), { recursive: true });
  writeFileSync(join(temp, "package.json"), JSON.stringify({ version: "0.9.0" }));
  writeFileSync(join(temp, "runtime/server.mjs"), 'var v = "0.9.0-staging.3";');
  writeFileSync(join(temp, "README.md"), "pins @relaymessenger/sdk@0.3.0-staging.8");
  writeFileSync(join(temp, "node_modules/dep/index.js"), '"0.9.0-staging.3"');
  assert.deepEqual(filesCarryingVersion(temp, "0.9.0-staging.3"), ["runtime/server.mjs"]);
  writeFileSync(join(temp, "runtime/server.mjs"), 'var v = "0.9.0";');
  assert.deepEqual(filesCarryingVersion(temp, "0.9.0-staging.3"), []);
});

// A plan like the one release-run derives, without reading a workspace.
const cookbookPlan = [
  { name: "@relaymessenger/sdk", current: "0.3.6-staging.46", version: "0.3.6" },
  { name: "@relaymessenger/chat-sdk-adapter", current: "0.3.7-staging.29", version: "0.3.7" },
];

function lockedCookbook(root, name, { nested = null } = {}) {
  const directory = join(root, "cookbook", name);
  mkdirSync(join(directory, "test"), { recursive: true });
  mkdirSync(join(directory, "node_modules/@relaymessenger/sdk"), { recursive: true });
  writeFileSync(join(directory, "package.json"), `${JSON.stringify({
    name,
    dependencies: {
      "@relaymessenger/chat-sdk-adapter": "0.3.7-staging.29",
      "@relaymessenger/sdk": "0.3.6-staging.46",
      zod: "4.6.5",
    },
  }, null, 2)}\n`);
  const packages = {
    "": { name, dependencies: { "@relaymessenger/chat-sdk-adapter": "0.3.7-staging.29", "@relaymessenger/sdk": "0.3.6-staging.46", zod: "4.6.5" } },
    "node_modules/@relaymessenger/chat-sdk-adapter": {
      version: "0.3.7-staging.29",
      resolved: "https://registry.npmjs.org/@relaymessenger/chat-sdk-adapter/-/chat-sdk-adapter-0.3.7-staging.29.tgz",
      integrity: "sha512-oldadapter",
    },
    "node_modules/@relaymessenger/sdk": {
      version: "0.3.6-staging.46",
      resolved: "https://registry.npmjs.org/@relaymessenger/sdk/-/sdk-0.3.6-staging.46.tgz",
      integrity: "sha512-oldsdk",
    },
  };
  if (nested) packages["node_modules/@relaymessenger/chat-sdk-adapter/node_modules/@relaymessenger/sdk"] = { version: nested };
  writeFileSync(join(directory, "package-lock.json"), `${JSON.stringify({ name, lockfileVersion: 3, packages }, null, 2)}\n`);
  writeFileSync(join(directory, "test/contracts.test.ts"),
    'expect(sdk).toBe("0.3.6-staging.46");\nexpect(lock).toMatchObject({ integrity: "sha512-oldadapter" });\n');
  writeFileSync(join(directory, "node_modules/@relaymessenger/sdk/package.json"), '{"version":"0.3.6-staging.46"}');
  return directory;
}

test("a cookbook's exact staging pins become the released versions, lockfile and tests with them", () => {
  const root = mkdtempSync(join(tmpdir(), "release-cookbook-"));
  const directory = lockedCookbook(root, "think");
  const integrityByName = new Map([
    ["@relaymessenger/sdk", "sha512-newsdk"],
    ["@relaymessenger/chat-sdk-adapter", "sha512-newadapter"],
  ]);
  const written = rewriteCookbooks(root, cookbookPlan, { integrityByName });
  assert.deepEqual(written.map((path) => path.slice(directory.length + 1)),
    ["package-lock.json", "package.json", "test/contracts.test.ts"]);
  const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  assert.deepEqual(manifest.dependencies, {
    "@relaymessenger/chat-sdk-adapter": "0.3.7", "@relaymessenger/sdk": "0.3.6", zod: "4.6.5",
  });
  assert.deepEqual(cookbookPrereleasePins(manifest, cookbookPlan), []);
  const lock = JSON.parse(readFileSync(join(directory, "package-lock.json"), "utf8"));
  assert.deepEqual(lock.packages[""].dependencies, manifest.dependencies);
  assert.deepEqual(lock.packages["node_modules/@relaymessenger/sdk"], {
    version: "0.3.6",
    resolved: "https://registry.npmjs.org/@relaymessenger/sdk/-/sdk-0.3.6.tgz",
    integrity: "sha512-newsdk",
  });
  assert.equal(lock.packages["node_modules/@relaymessenger/chat-sdk-adapter"].integrity, "sha512-newadapter");
  assert.equal(readFileSync(join(directory, "test/contracts.test.ts"), "utf8"),
    'expect(sdk).toBe("0.3.6");\nexpect(lock).toMatchObject({ integrity: "sha512-newadapter" });\n');
  // Installed copies are not source.
  assert.equal(readFileSync(join(directory, "node_modules/@relaymessenger/sdk/package.json"), "utf8"),
    '{"version":"0.3.6-staging.46"}');
  // Idempotent: nothing is left to derive.
  assert.deepEqual(rewriteCookbooks(root, cookbookPlan, { integrityByName }), []);
});

test("an unlocked cookbook's staging range keeps its operator and loses only the prerelease", () => {
  const root = mkdtempSync(join(tmpdir(), "release-cookbook-range-"));
  const directory = join(root, "cookbook", "send-a-message");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "package.json"), JSON.stringify({
    dependencies: { "@relaymessenger/sdk": "^0.3.0-staging.0" },
    devDependencies: { "@relaymessenger/chat-sdk-adapter": "~0.3.7-staging.2", typescript: "7.0.2" },
  }));
  rewriteCookbooks(root, cookbookPlan);
  const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  assert.equal(manifest.dependencies["@relaymessenger/sdk"], "^0.3.0");
  assert.equal(manifest.devDependencies["@relaymessenger/chat-sdk-adapter"], "~0.3.7");
  assert.equal(manifest.devDependencies.typescript, "7.0.2");
});

test("an unlocked cookbook's range moves to a release it does not admit", () => {
  // Release run 36796792561 (2026-10-01) published sdk 0.4.0 while three
  // unlocked cookbooks still said ^0.3.0, which installs 0.3.6, not latest.
  const root = mkdtempSync(join(tmpdir(), "release-cookbook-minor-"));
  const directory = join(root, "cookbook", "send-a-message");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "package.json"), JSON.stringify({
    dependencies: { "@relaymessenger/sdk": "^0.3.0" },
    devDependencies: { "@relaymessenger/chat-sdk-adapter": "~0.3.7-staging.2" },
  }));
  const minorPlan = [
    { name: "@relaymessenger/sdk", current: "0.4.0-staging.3", version: "0.4.0" },
    { name: "@relaymessenger/chat-sdk-adapter", current: "0.3.8-staging.1", version: "0.3.8" },
  ];
  const written = rewriteCookbooks(root, minorPlan);
  assert.deepEqual(written, [join(directory, "package.json")]);
  const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  assert.equal(manifest.dependencies["@relaymessenger/sdk"], "^0.4.0");
  assert.equal(manifest.devDependencies["@relaymessenger/chat-sdk-adapter"], "~0.3.7");
  // A range that already admits the release is left alone.
  assert.deepEqual(rewriteCookbooks(root, minorPlan), []);
});

test("the cookbook rewrite fails closed", () => {
  const root = mkdtempSync(join(tmpdir(), "release-cookbook-closed-"));
  // No integrity for a locked package: the lockfile would name bytes nobody checked.
  const noIntegrity = lockedCookbook(root, "no-integrity");
  assert.throws(() => rewriteCookbook(noIntegrity, cookbookPlan, {
    integrityByName: new Map([["@relaymessenger/sdk", "sha512-newsdk"]]),
  }), /no integrity for @relaymessenger\/chat-sdk-adapter@0.3.7/u);
  // A staging version nested under another package survives the rewrite.
  const nested = lockedCookbook(root, "nested", { nested: "0.3.6-staging.46" });
  assert.doesNotThrow(() => rewriteCookbook(nested, cookbookPlan, {
    integrityByName: new Map([["@relaymessenger/sdk", "s1"], ["@relaymessenger/chat-sdk-adapter", "s2"]]),
  }));
  const stale = lockedCookbook(root, "stale", { nested: "0.3.6-staging.40" });
  const pins = JSON.parse(readFileSync(join(stale, "package.json"), "utf8"));
  assert.equal(cookbookPrereleasePins(pins, cookbookPlan).length, 2);
  assert.throws(() => rewriteCookbook(stale, cookbookPlan, {
    integrityByName: new Map([["@relaymessenger/sdk", "s1"], ["@relaymessenger/chat-sdk-adapter", "s2"]]),
  }), /still resolves node_modules\/@relaymessenger\/chat-sdk-adapter\/node_modules\/@relaymessenger\/sdk to 0.3.6-staging.40/u);
  // A pin shape the release cannot derive.
  const odd = join(root, "cookbook", "odd");
  mkdirSync(odd, { recursive: true });
  writeFileSync(join(odd, "package.json"), JSON.stringify({ dependencies: { "@relaymessenger/sdk": ">=0.3.0-staging.1 <1" } }));
  assert.throws(() => rewriteCookbook(odd, cookbookPlan), /only X.Y.Z-staging.N/u);
});
