import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const pkg = JSON.parse(readFileSync(resolve(repoRoot, "packages/relaymessenger/package.json"), "utf8"));
const lock = JSON.parse(readFileSync(resolve(repoRoot, "package-lock.json"), "utf8"));
const expectedTag = `relaymessenger-v${pkg.version}`;

function checkVersionMetadata() {
  assert.equal(pkg.name, "relaymessenger", "release workflow only publishes the relaymessenger package");
  assert.match(pkg.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u, "invalid package version");
  assert.equal(
    lock.packages?.["packages/relaymessenger"]?.version,
    pkg.version,
    "package-lock relaymessenger version does not match package.json",
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

/**
 * npm forwards lifecycle stdout before its final --json document. Parse the
 * trailing complete JSON value instead of assuming stdout starts with JSON.
 */
export function parseTrailingNpmJson(output) {
  const lines = output.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const first = lines[index]?.trimStart()[0];
    if (first !== "[" && first !== "{") continue;
    const candidate = lines.slice(index).join("\n").trim();
    try {
      return JSON.parse(candidate);
    } catch {
      // A lifecycle line can itself begin with punctuation; continue until a
      // complete trailing JSON value is found.
    }
  }
  throw new Error(`npm output did not end in a JSON document:\n${output.trim()}`);
}

function packRelaymessengerJson(destination, dryRun = false) {
  const output = execFileSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    [
      "pack",
      "--workspace",
      "relaymessenger",
      "--json",
      "--silent",
      ...(dryRun ? ["--dry-run"] : []),
      "--pack-destination",
      destination,
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
  const packed = parseTrailingNpmJson(output);
  assert.ok(Array.isArray(packed) && packed.length === 1, "npm pack must describe one relaymessenger archive");
  assert.match(output, /generated and strictly validated Claude marketplace plus/);
  const paths = new Set((packed[0]?.files ?? []).map((file) => file.path));
  for (const required of [
    "claude-plugin/marketplace/.claude-plugin/marketplace.json",
    "claude-plugin/marketplace/plugins/relay/runtime/server.mjs",
  ]) {
    assert.equal(paths.has(required), true, `npm pack output missing ${required}`);
  }
  assert.ok(
    [...paths].some((path) => /^openclaw-plugin\/.+\.tgz$/u.test(path)),
    "npm pack output missing bundled OpenClaw archive",
  );
  return packed;
}

function packJsonSmoke() {
  const destination = mkdtempSync(resolve(tmpdir(), "relaymessenger-release-pack-json-"));
  try {
    const packed = packRelaymessengerJson(destination);
    assert.match(packed[0]?.integrity ?? "", /^sha512-/u);
    packRelaymessengerJson(destination, true);
  } finally {
    rmSync(destination, { recursive: true, force: true });
  }
  process.stdout.write("relaymessenger prepack JSON and outer npm pack --dry-run smoke passed\n");
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
    const destination = mkdtempSync(resolve(tmpdir(), "relaymessenger-release-pack-"));
    try {
      const packed = packRelaymessengerJson(destination);
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
else if (command === "pack-json-smoke") packJsonSmoke();
else throw new Error(
  "usage: relaymessenger-release.mjs check-tag <relaymessenger-vX.Y.Z> | registry-state | pack-json-smoke",
);
