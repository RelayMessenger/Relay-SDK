import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const pkg = JSON.parse(readFileSync(resolve(repoRoot, "packages/relayapp/package.json"), "utf8"));
const lock = JSON.parse(readFileSync(resolve(repoRoot, "package-lock.json"), "utf8"));
const expectedTag = `relayapp-v${pkg.version}`;

function checkVersionMetadata() {
  assert.equal(pkg.name, "relayapp", "release workflow only publishes the relayapp package");
  assert.match(pkg.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u, "invalid package version");
  assert.equal(
    lock.packages?.["packages/relayapp"]?.version,
    pkg.version,
    "package-lock relayapp version does not match package.json",
  );
}

function checkTag(tag) {
  checkVersionMetadata();
  assert.equal(tag, expectedTag, `release tag must be exactly ${expectedTag}`);
  const exact = execFileSync("git", ["describe", "--exact-match", "--tags", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
  assert.equal(exact, tag, `checked-out commit is tagged ${exact}, not ${tag}`);
  process.stdout.write(`release tag/version contract passed (${tag})\n`);
}

function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

function registryState() {
  checkVersionMetadata();
  const result = spawnSync("npm", ["view", `${pkg.name}@${pkg.version}`, "version", "--json"], {
    cwd: repoRoot,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (result.status === 0) {
    const registryVersion = JSON.parse(result.stdout);
    assert.equal(registryVersion, pkg.version);
    const destination = mkdtempSync(resolve(tmpdir(), "relayapp-release-pack-"));
    try {
      const packedOutput = execFileSync(
        process.platform === "win32" ? "npm.cmd" : "npm",
        ["pack", "--workspace", "relayapp", "--json", "--silent", "--pack-destination", destination],
        { cwd: repoRoot, encoding: "utf8" },
      );
      const packed = JSON.parse(packedOutput);
      const localIntegrity = packed[0]?.integrity;
      const registryIntegrity = JSON.parse(
        execFileSync(
          process.platform === "win32" ? "npm.cmd" : "npm",
          ["view", `${pkg.name}@${pkg.version}`, "dist.integrity", "--json"],
          { cwd: repoRoot, encoding: "utf8" },
        ),
      );
      assert.equal(
        registryIntegrity,
        localIntegrity,
        `${pkg.name}@${pkg.version} exists but does not match this tagged source`,
      );
    } finally {
      rmSync(destination, { recursive: true, force: true });
    }
    setOutput("published", "true");
    process.stdout.write(`${pkg.name}@${pkg.version} is already published with matching integrity\n`);
    return;
  }
  const detail = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (!/E404|404 Not Found|is not in this registry/iu.test(detail)) {
    throw new Error(`could not establish registry availability:\n${detail.trim()}`);
  }
  setOutput("published", "false");
  process.stdout.write(`${pkg.name}@${pkg.version} is not yet published\n`);
}

const [command, value] = process.argv.slice(2);
if (command === "check-tag") checkTag(value ?? "");
else if (command === "registry-state") registryState();
else throw new Error("usage: relayapp-release.mjs check-tag <relayapp-vX.Y.Z> | registry-state");
