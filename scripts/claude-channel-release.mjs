import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const pkg = JSON.parse(
  readFileSync(resolve(repoRoot, "integrations/claude-code/package.json"), "utf8"),
);
const expectedTag = `claude-channel-v${pkg.version}`;
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function checkVersionMetadata() {
  assert.equal(pkg.name, "relay-claude-channel", "this workflow publishes only the channel");
  assert.match(pkg.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u, "invalid package version");
}

function checkTag(tag) {
  checkVersionMetadata();
  assert.equal(tag, expectedTag, `release tag must be exactly ${expectedTag}`);
  // Several packages can release from one commit, so the check is that OUR
  // tag points at HEAD, not that it is the only tag here: `git describe
  // --exact-match` picks a single winner among co-located tags and failed
  // two of three releases cut from the same merge.
  const pointing = execFileSync("git", ["tag", "--points-at", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim().split("\n").filter(Boolean);
  assert.ok(pointing.includes(tag), `checked-out commit is tagged [${pointing.join(", ")}], not ${tag}`);
  process.stdout.write(`release tag/version contract passed (${tag})\n`);
}

function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

/**
 * A retried release must never republish over a good artifact, so treat an
 * already-present version as success and let the verify step re-prove it.
 */
function registryState() {
  checkVersionMetadata();
  const result = spawnSync(npm, ["view", `${pkg.name}@${pkg.version}`, "version", "--json"], {
    cwd: repoRoot,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (result.status === 0) {
    assert.equal(JSON.parse(result.stdout), pkg.version);
    setOutput("published", "true");
    process.stdout.write(`${pkg.name}@${pkg.version} is already published\n`);
    return;
  }
  const detail = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (!/E404|404 Not Found|is not in this registry/iu.test(detail)) {
    throw new Error(`could not establish registry availability:\n${detail.trim()}`);
  }
  setOutput("published", "false");
  process.stdout.write(`${pkg.name}@${pkg.version} is not yet published\n`);
}

/**
 * Install the exact published version clean and prove the plugin payload. The
 * package is a Claude Code plugin, not an importable library: the smoke proves
 * the shipped plugin manifest parses and the runtime server exists and parses.
 */
async function verifyRegistry() {
  checkVersionMetadata();
  const temp = mkdtempSync(join(tmpdir(), "claude-channel-registry-smoke-"));
  try {
    writeFileSync(
      join(temp, "package.json"),
      `${JSON.stringify({ name: "claude-channel-registry-smoke", private: true, type: "module" }, null, 2)}\n`,
    );
    let installed = false;
    let lastFailure = "";
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      const result = spawnSync(
        npm,
        ["install", "--no-audit", "--no-fund", "--prefer-online", `${pkg.name}@${pkg.version}`],
        { cwd: temp, encoding: "utf8", shell: process.platform === "win32" },
      );
      if (result.status === 0) {
        installed = true;
        break;
      }
      lastFailure = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
      if (attempt < 6) await new Promise((wait) => setTimeout(wait, 5_000));
    }
    assert.equal(installed, true, `registry install did not converge:\n${lastFailure}`);

    const installedRoot = join(temp, "node_modules", "relay-claude-channel");
    const installedPkg = JSON.parse(readFileSync(join(installedRoot, "package.json"), "utf8"));
    assert.equal(installedPkg.version, pkg.version);

    const manifest = JSON.parse(
      readFileSync(join(installedRoot, ".claude-plugin", "plugin.json"), "utf8"),
    );
    assert.equal(typeof manifest, "object");
    assert.equal(existsSync(join(installedRoot, "runtime", "server.mjs")), true, "missing runtime/server.mjs");
    const checked = spawnSync(process.execPath, ["--check", join(installedRoot, "runtime", "server.mjs")], {
      cwd: temp,
      encoding: "utf8",
    });
    assert.equal(checked.status, 0, `runtime server failed to parse:\n${checked.stderr}`);
    process.stdout.write(`registry-installed ${pkg.name}@${pkg.version} smoke passed\n`);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

const [command, value] = process.argv.slice(2);
if (command === "check-tag") checkTag(value ?? "");
else if (command === "registry-state") registryState();
else if (command === "verify-registry") await verifyRegistry();
else throw new Error(
  "usage: claude-channel-release.mjs check-tag <claude-channel-vX.Y.Z> | registry-state | verify-registry",
);
