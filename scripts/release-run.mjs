// The release job on main. Reads the tree as staging wrote it, derives each
// package's plain version, skips what npm already has, and publishes the rest
// in dependency order as `latest`; a git tag records each publish afterwards.
//
//   node scripts/release-run.mjs            publish (push to main)
//   node scripts/release-run.mjs --dry-run  derive, pack, `npm publish --dry-run`, stop
//
// Environment:
//   NODE_AUTH_TOKEN          npm publish credential (publish only)
//   GH_TOKEN                 creates the record tag through the GitHub API
//   RELAY_ASSUME_PUBLISHED   dry-run proof only: comma-separated name@version
//                            the plan treats as already on npm
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readManifests, releasePlan, rewritePackage } from "./release-derive.mjs";
import { releasePackages } from "./release-packages.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dryRun = process.argv.includes("--dry-run");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const registry = "https://registry.npmjs.org/";
const say = (message) => process.stdout.write(`${message}\n`);

function run(command, args, { allowFailure = false, env = {} } = {}) {
  say(`$ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, ...env },
  });
  if (!allowFailure) assert.equal(result.status, 0, `${command} ${args[0]} failed`);
  return result;
}

function view(spec, field) {
  const result = spawnSync(npm, ["view", spec, field, "--json", "--registry", registry], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status === 0) {
    const parsed = result.stdout.trim() ? JSON.parse(result.stdout) : null;
    return { found: parsed !== null, value: Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : parsed };
  }
  const detail = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (/E404|404 Not Found|is not in this registry|No match found/iu.test(detail)) {
    return { found: false };
  }
  throw new Error(`npm view ${spec} ${field} failed:\n${detail.trim()}`);
}

const assumed = new Set(
  (dryRun ? process.env.RELAY_ASSUME_PUBLISHED ?? "" : "")
    .split(",").map((value) => value.trim()).filter(Boolean),
);
const isPublished = (name, version) =>
  assumed.has(`${name}@${version}`) || view(`${name}@${version}`, "version").found;

const plan = releasePlan(readManifests(root), isPublished);
say(`release plan (${dryRun ? "dry run" : "publish"}):`);
for (const row of plan) {
  say(`  ${row.key.padEnd(16)} ${row.name}@${row.current} -> ${row.version}  ${row.action}${
    assumed.has(`${row.name}@${row.version}`) ? " (assumed published)" : ""
  }  tag ${row.tag}`);
}

const sdkRow = plan.find((row) => row.key === "sdk");
let sdkIntegrity = null;
if (sdkRow.published && !assumed.has(`${sdkRow.name}@${sdkRow.version}`)) {
  sdkIntegrity = view(`${sdkRow.name}@${sdkRow.version}`, "dist.integrity").value;
}

const tarballFor = (row) => {
  const destination = join(".release-tmp", "release", row.key);
  run(process.execPath, ["scripts/release-package.mjs", "pack", "--package", row.key, "--destination", destination], {
    env: { GITHUB_OUTPUT: "" },
  });
  const [name] = readdirSync(join(root, destination)).filter((entry) => entry.endsWith(".tgz"));
  const path = join(root, destination, name);
  return { path, integrity: `sha512-${createHash("sha512").update(readFileSync(path)).digest("base64")}` };
};

async function waitForRegistry(row, integrity) {
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const seen = view(`${row.name}@${row.version}`, "dist.integrity");
    if (seen.found) {
      assert.equal(seen.value, integrity, `${row.name}@${row.version} on npm is not the tarball this run packed`);
      return;
    }
    await new Promise((wake) => setTimeout(wake, 5_000));
  }
  throw new Error(`${row.name}@${row.version} did not appear on npm`);
}

async function github(path, body) {
  const repository = process.env.GITHUB_REPOSITORY;
  assert.ok(repository && process.env.GH_TOKEN, "GITHUB_REPOSITORY and GH_TOKEN are required to record a tag");
  const response = await fetch(`https://api.github.com/repos/${repository}${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${process.env.GH_TOKEN}`,
      "user-agent": "relay-release-run",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function recordTag(row) {
  const sha = process.env.GITHUB_SHA;
  assert.match(sha ?? "", /^[0-9a-f]{40}$/u, "GITHUB_SHA must name the released commit");
  const existing = await github(`/git/ref/tags/${row.tag}`);
  if (existing.status === 200) {
    assert.equal(existing.body.object?.sha, sha, `${row.tag} already exists on another commit`);
    say(`tag ${row.tag} already records ${sha}`);
    return;
  }
  const created = await github("/git/refs", { ref: `refs/tags/${row.tag}`, sha });
  assert.equal(created.status, 201, `could not create ${row.tag}: ${JSON.stringify(created.body)}`);
  say(`tag ${row.tag} records ${sha}`);
}

rmSync(join(root, ".release-tmp", "release"), { recursive: true, force: true });
for (const row of plan) {
  say(`\n=== ${row.key}: ${row.name}@${row.version} (${row.action}) ===`);
  if (row.action === "skip") continue;
  const entry = releasePackages[row.key];
  const written = rewritePackage(root, row.key, plan, { sdkIntegrity });
  say(`rewrote ${written.map((path) => path.slice(root.length + 1)).join(", ")}`);
  // Reconcile the workspace links and lockfile with the rewritten pins.
  run(npm, ["install", "--no-audit", "--no-fund"]);
  const dependsOnRelay = row.key !== "sdk" && row.key !== "chat-sdk-adapter";
  if (dryRun && dependsOnRelay) {
    // A dependent's validation installs its Relay pins from npm; in a dry run
    // they are not there yet, so build what the tarball needs and stop there.
    run(npm, ["run", "build", "--workspace", row.name]);
  } else {
    run(npm, ["run", entry.validate], { env: { RELAY_RELEASE: "1" } });
  }
  const tarball = tarballFor(row);
  run(npm, [
    "publish", tarball.path,
    "--access", "public",
    "--tag", "latest",
    "--no-provenance",
    "--registry", registry,
    ...(dryRun ? ["--dry-run"] : []),
  ]);
  if (dryRun) continue;
  await waitForRegistry(row, tarball.integrity);
  const tags = view(row.name, "dist-tags").value;
  assert.equal(tags?.latest, row.version, `latest dist-tag is ${tags?.latest}, not ${row.version}`);
  run(process.execPath, ["scripts/release-package.mjs", "verify-registry", "--package", row.key], {
    env: { GITHUB_OUTPUT: "" },
  });
  await recordTag(row);
  if (row.key === "sdk") sdkIntegrity = tarball.integrity;
}
say(`\nrelease ${dryRun ? "dry run" : "publish"} finished: ${
  plan.map((row) => `${row.key}=${row.action}`).join(" ")
}`);
