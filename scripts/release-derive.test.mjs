import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
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
  // The reverse order must be refused: the sdk would follow its dependents.
  assert.throws(
    () => releaseOrder(manifests, [...releaseKeys].reverse()),
    /depends on sdk, which must release before it/u,
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
