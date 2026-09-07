import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { linkCookbookWorkspaces } from "./link-cookbook-workspaces.mjs";
import { syncImportMetadata } from "./sync-import-metadata.mjs";
import { applyPins, applyVersion } from "./staging-bump.mjs";
import { readManifests, releasePlan, rewriteReleaseWorkspace } from "./release-derive.mjs";

const root = new URL("..", import.meta.url).pathname;
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "release-metadata-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const path of ["sources.import-manifest.json", "scripts", "packages", "contracts", "skills", "plugins", "tooling", ".agents", ".cursor-plugin", ".claude-plugin", "cookbook"]) {
    cpSync(join(root, path), join(dir, path), { recursive: true, filter: (path) => !["node_modules", "dist", ".release", ".release-tmp"].includes(basename(path)) });
  }
  return dir;
}
function run(dir, script, ...args) {
  return spawnSync(process.execPath, [join(dir, "scripts", script), ...args], { cwd: dir, encoding: "utf8" });
}

test("automatic versions regenerate global marketplace; contract check follows workspace, not historical skill pin", (t) => {
  const dir = fixture(t);
  const historical = readFileSync(join(dir, "skills/relay/references/relay-v1-lock.json"));
  const api = readFileSync(join(dir, "contracts/relay-v1-openapi.yaml"));
  applyVersion(dir, "claude-code", "0.99.0-staging.7");
  applyVersion(dir, "sdk", "0.99.0-staging.8");
  assert.notEqual(run(dir, "sync-root-discovery.mjs", "--check").status, 0);
  const generated = run(dir, "sync-root-discovery.mjs", "--write");
  assert.equal(generated.status, 0, generated.stderr);
  assert.equal(JSON.parse(readFileSync(join(dir, ".claude-plugin/marketplace.json"))).plugins[0].version, "0.99.0-staging.7");
  assert.notEqual(run(dir, "validate-contract-copies.mjs").status, 0, "stale workspace lock must fail");
  const manifests = readManifests(dir);
  for (const key of ["openclaw", "claude-code"]) applyPins(dir, key, manifests, { sdk: { version: manifests.sdk.version, integrity: "sha512-mock" } }, { write: true });
  const checked = run(dir, "validate-contract-copies.mjs");
  assert.equal(checked.status, 0, checked.stderr);
  assert.deepEqual(readFileSync(join(dir, "skills/relay/references/relay-v1-lock.json")), historical);
  assert.deepEqual(readFileSync(join(dir, "contracts/relay-v1-openapi.yaml")), api);
  assert.equal(run(dir, "sync-root-discovery.mjs", "--check").status, 0);
});

test("release skip does not leave a staging workspace behind for dependent resolution", (t) => {
  const dir = fixture(t);
  const plan = releasePlan(readManifests(dir), (name) => name === "@relaymessenger/sdk");
  assert.equal(plan[0].action, "skip");
  rewriteReleaseWorkspace(dir, plan, { sdkIntegrity: "sha512-mock" });
  const manifests = readManifests(dir);
  assert.equal(manifests.sdk.version, plan[0].version);
  assert.equal(manifests.cli.dependencies[manifests.sdk.name], manifests.sdk.version);
  assert.equal(plan[0].action, "skip", "rewriting must not change registry decisions");
});

test("import metadata updates destination hashes only and rejects subsequent drift", (t) => {
  const dir = fixture(t);
  const before = JSON.parse(readFileSync(join(dir, "sources.import-manifest.json")));
  applyVersion(dir, "sdk", "0.99.0-staging.9");
  assert.throws(() => syncImportMetadata(dir), /drifted/u);
  const after = syncImportMetadata(dir, { write: true });
  assert.equal(after.entries.length, before.entries.length);
  const sourceFields = (entry) => Object.fromEntries(Object.entries(entry).filter(([key]) => !["destination_sha256", "destination_mode", "status"].includes(key)));
  assert.deepEqual(after.entries.map(sourceFields), before.entries.map(sourceFields));
  syncImportMetadata(dir);
  applyVersion(dir, "sdk", "0.99.0-staging.10");
  assert.throws(() => syncImportMetadata(dir), /drifted/u);
});

test("cookbook workspace linking survives future prerelease tuples without changing standalone or locked manifests", (t) => {
  const dir = fixture(t);
  const manifestPath = join(dir, "cookbook/send-a-message/package.json");
  const before = readFileSync(manifestPath);
  const locked = readFileSync(join(dir, "cookbook/cloudflare-think-agent/package.json"));
  applyVersion(dir, "sdk", "0.99.0-staging.9");
  const linked = linkCookbookWorkspaces(dir);
  assert.ok(linked.includes("send-a-message: @relaymessenger/sdk"));
  assert.ok(!linked.some((name) => name.startsWith("cloudflare-think-agent:")));
  assert.equal(realpathSync(join(dir, "cookbook/send-a-message/node_modules/@relaymessenger/sdk")), realpathSync(join(dir, "packages/sdk")));
  assert.deepEqual(readFileSync(manifestPath), before);
  assert.deepEqual(readFileSync(join(dir, "cookbook/cloudflare-think-agent/package.json")), locked);
  assert.deepEqual(linkCookbookWorkspaces(dir), []);
});
