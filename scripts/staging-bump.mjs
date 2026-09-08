// Versions every staging package automatically, so no hand-written bump commit
// ever gates a publish again (owner ruling, 2026-09-07: releases are automatic,
// nothing manual, ever).
//
// The staging publish (scripts/publish-package-staging.mjs) refuses a changed
// tarball under a version npm already has, and the production release on main
// (scripts/release-derive.mjs) strips `-staging.N` and skips what npm already
// has. Both are correct and both need a version that moves whenever content
// moves. This program supplies that version, in the catalog order of
// scripts/release-packages.mjs so a dependent is decided after its dependency:
//
//   1. pin every Relay dependency to the version this run decided for it and
//      carry the SDK's version and tarball integrity into the contract locks
//      that record them (the pin cascade Changesets performs in pre mode:
//      "this will bump dependent packages that wouldn't be bumped in normal
//      releases", changesets.dev/guide/prereleases);
//   2. build and pack the package, and compare the packed files, hash by hash,
//      with the tarball npm holds for the version the tree names;
//   3. decide the next version from the table `nextVersion` documents;
//   4. rewrite the manifest (and, for claude-code, the plugin manifests that
//      must ship the same version), rebuild so generated files carry it, and
//      pack again so the integrity a dependent locks is the one that publishes.
//
// The publish workflow commits the result back to staging and then publishes
// each changed package from that commit, in the same order. The main release
// then derives the plain version and finds it unpublished, as it must:
// semver 2.0.0 item 9 gives `X.Y.Z-staging.N` lower precedence than `X.Y.Z`, so
// once `X.Y.Z` is on npm the base has to move.
//
//   node scripts/staging-bump.mjs --write    rewrite the tree, print the plan
//   node scripts/staging-bump.mjs --dry-run  print the plan, touch nothing tracked
//
// GITHUB_OUTPUT, when set, receives `changed=,<comma-separated keys>,` (the
// delimiters let the workflow test `,key,` without a prefix match) and
// `bumped=<true|false>`.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  internalDependencies,
  readManifests,
  releaseOrder,
} from "./release-derive.mjs";
import { releasePackages } from "./release-packages.mjs";

const STAGING_SHAPE = /^(\d+)\.(\d+)\.(\d+)-staging\.(\d+)$/u;

/** Splits `X.Y.Z-staging.N`; anything else fails closed. */
export function parseStagingVersion(version) {
  const match = STAGING_SHAPE.exec(String(version));
  if (!match) {
    throw new Error(
      `${JSON.stringify(version)} is not an X.Y.Z-staging.N version`,
    );
  }
  const [, major, minor, patch, prerelease] = match.map(Number);
  return { base: `${major}.${minor}.${patch}`, major, minor, patch, prerelease };
}

/**
 * The decision table. Inputs are facts about one package:
 *
 *   version          the X.Y.Z-staging.N the tree names
 *   versionPublished npm has `name@version`
 *   basePublished    npm has the plain `name@X.Y.Z`
 *   contentChanged   the packed files differ from npm's `name@version`
 *                    (only meaningful when versionPublished)
 *   isPublished(v)   npm has `name@v`, asked for each candidate
 *
 *   published | base on npm | content changed | result
 *   ----------+-------------+-----------------+------------------------------
 *   yes       | any         | no              | none: nothing new to ship
 *   yes       | no          | yes             | X.Y.Z-staging.(N+1)
 *   yes       | yes         | yes             | X.Y.(Z+1)-staging.0
 *   no        | no          | (not asked)     | keep: the tree already names
 *             |             |                 | an unpublished prerelease
 *   no        | yes         | (not asked)     | X.Y.(Z+1)-staging.0: main would
 *             |             |                 | derive X.Y.Z and skip it forever
 *
 * A candidate npm already has (a prerelease published and then abandoned)
 * moves on to the next N. The base test is existence, not the `latest` tag:
 * semver gives every `X.Y.Z-staging.N` lower precedence than `X.Y.Z`, so any
 * published `X.Y.Z` makes the base unusable whatever `latest` says.
 */
export function nextVersion({
  version,
  versionPublished,
  basePublished,
  contentChanged,
  isPublished,
}) {
  const parsed = parseStagingVersion(version);
  if (versionPublished && !contentChanged) {
    return { action: "none", version, reason: "npm holds this content" };
  }
  if (!versionPublished && !basePublished) {
    return {
      action: "keep",
      version,
      reason: "the tree names an unpublished prerelease of an unpublished base",
    };
  }
  let base = parsed.base;
  let prerelease = parsed.prerelease + 1;
  let reason = "content changed under a published prerelease";
  if (basePublished) {
    base = `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
    prerelease = 0;
    reason = versionPublished
      ? `content changed and ${parsed.base} is already on npm`
      : `${parsed.base} is already on npm, so main could never publish it`;
  }
  let candidate = `${base}-staging.${prerelease}`;
  while (isPublished(candidate)) {
    prerelease += 1;
    candidate = `${base}-staging.${prerelease}`;
  }
  return { action: "bump", version: candidate, reason };
}

/** sha256 per file inside a packed tarball, keyed by path under `package/`. */
export function tarballFileHashes(tarballPath, tar = runTar) {
  const listing = tar(["-tzf", tarballPath]).split("\n").filter(Boolean).sort();
  const hashes = {};
  for (const entry of listing) {
    if (entry.endsWith("/")) continue;
    const bytes = tar(["-xOzf", tarballPath, entry], "buffer");
    hashes[entry] = createHash("sha256").update(bytes).digest("hex");
  }
  return hashes;
}

/** The paths whose hashes differ, or exist on one side only. */
export function differingFiles(left, right) {
  const paths = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...paths].filter((path) => left[path] !== right[path]).sort();
}

function runTar(args, encoding = "utf8") {
  const result = spawnSync("tar", args, {
    encoding: encoding === "buffer" ? "buffer" : "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`tar ${args.join(" ")} failed: ${String(result.stderr)}`);
  }
  return result.stdout;
}

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (path, value) =>
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

/**
 * The files besides package.json that must name a package's version, as
 * scripts/release-derive.mjs also rewrites them for main. claude-code's
 * plugin manifests are read by Claude Code instead of package.json, so the
 * two are one identity (release-packages.mjs, `manifestVersion`).
 */
export function versionCarriers(key) {
  return {
    "claude-code": [
      ".claude-plugin/plugin.json",
      "plugin/.claude-plugin/plugin.json",
    ],
  }[key] ?? [];
}

export function contractLockPaths(key) {
  return {
    openclaw: ["contracts/relay-v1.lock.json"],
    "claude-code": [
      "contracts/relay-v1.lock.json",
      "plugin/contracts/relay-v1.lock.json",
    ],
  }[key] ?? [];
}

/**
 * Rewrites one package's Relay pins and contract locks to the decided
 * versions. Returns the relative paths that would change; writes them only
 * when `write` is true, so a dry run reports the same paths it would touch.
 */
export function applyPins(root, key, manifests, decided, { write }) {
  const directory = join(root, releasePackages[key].directory);
  const manifest = readJson(join(directory, "package.json"));
  const changed = [];
  let manifestChanged = false;
  for (const dependency of internalDependencies(manifest, manifests)) {
    const target = decided[dependency.key]?.version;
    if (!target) continue;
    if (manifest[dependency.field][dependency.name] !== target) {
      manifest[dependency.field][dependency.name] = target;
      manifestChanged = true;
    }
  }
  if (manifestChanged) {
    changed.push("package.json");
    if (write) writeJson(join(directory, "package.json"), manifest);
  }
  const sdk = decided.sdk;
  for (const relative of contractLockPaths(key)) {
    if (!sdk) break;
    const path = join(directory, relative);
    const lock = readJson(path);
    assert.equal(lock.relaySdk?.package, "@relaymessenger/sdk", `${path} locks no SDK`);
    if (
      lock.relaySdk.version === sdk.version
      && lock.relaySdk.integrity === sdk.integrity
    ) continue;
    lock.relaySdk.version = sdk.version;
    lock.relaySdk.integrity = sdk.integrity;
    changed.push(relative);
    if (write) writeJson(path, lock);
  }
  return changed;
}

/** Writes the decided version into package.json and every carrier. */
export function applyVersion(root, key, version) {
  const directory = join(root, releasePackages[key].directory);
  const written = [];
  for (const relative of ["package.json", ...versionCarriers(key)]) {
    const path = join(directory, relative);
    const value = readJson(path);
    value.version = version;
    writeJson(path, value);
    written.push(relative);
  }
  if (key === "claude-code") {
    const path = join(directory, ".claude-plugin/marketplace.json");
    const marketplace = readJson(path);
    marketplace.plugins[0].version = version;
    writeJson(path, marketplace);
    written.push(".claude-plugin/marketplace.json");
  }
  return written;
}

// ---------------------------------------------------------------- the driver

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const registry = "https://registry.npmjs.org/";
const say = (message) => process.stdout.write(`${message}\n`);

function run(command, args, { env = {} } = {}) {
  say(`$ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, ...env },
  });
  assert.equal(result.status, 0, `${command} ${args[0]} failed`);
}

function view(spec, field) {
  const result = spawnSync(npm, ["view", spec, field, "--json", "--registry", registry], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status === 0) {
    const parsed = result.stdout.trim() ? JSON.parse(result.stdout) : null;
    return {
      found: parsed !== null,
      value: Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : parsed,
    };
  }
  const detail = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (/E404|404 Not Found|is not in this registry|No match found/iu.test(detail)) {
    return { found: false };
  }
  throw new Error(`npm view ${spec} ${field} failed:\n${detail.trim()}`);
}

const integrityOf = (path) =>
  `sha512-${createHash("sha512").update(readFileSync(path)).digest("base64")}`;

function pack(key, destination) {
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  run(npm, [
    "pack",
    "--workspace", releasePackages[key].workspace,
    "--ignore-scripts",
    "--pack-destination", destination,
  ]);
  const [name] = readdirSync(destination).filter((entry) => entry.endsWith(".tgz"));
  assert.ok(name, `npm pack wrote no tarball for ${key}`);
  return join(destination, name);
}

async function fetchRegistryTarball(name, version, destination) {
  const url = view(`${name}@${version}`, "dist.tarball").value;
  assert.match(String(url), /^https:\/\//u, `${name}@${version} has no tarball URL`);
  const response = await fetch(url, { headers: { "user-agent": "relay-staging-bump" } });
  assert.equal(response.status, 200, `${url} answered ${response.status}`);
  mkdirSync(destination, { recursive: true });
  const path = join(destination, "registry.tgz");
  writeFileSync(path, Buffer.from(await response.arrayBuffer()));
  return path;
}

export async function stagingBump({ write }) {
  const manifests = readManifests(root);
  const order = releaseOrder(manifests);
  const scratch = join(root, ".release-tmp", "staging-bump");
  rmSync(scratch, { recursive: true, force: true });
  const decided = {};
  const plan = [];
  for (const key of order) {
    const entry = releasePackages[key];
    const name = entry.workspace;
    say(`\n=== ${key}: ${name} ===`);
    const pinned = applyPins(root, key, manifests, decided, { write });
    if (pinned.length) say(`${write ? "rewrote" : "would rewrite"} pins in ${pinned.join(", ")}`);
    run(npm, ["run", "build", "--workspace", name]);
    const before = readJson(join(root, entry.directory, "package.json"));
    const version = before.version;
    parseStagingVersion(version);
    const packed = pack(key, join(scratch, key, "tree"));
    const versionPublished = view(`${name}@${version}`, "version").found;
    const basePublished = view(`${name}@${parseStagingVersion(version).base}`, "version").found;
    let contentChanged = null;
    let changedFiles = [];
    if (versionPublished) {
      const published = await fetchRegistryTarball(name, version, join(scratch, key, "registry"));
      changedFiles = differingFiles(tarballFileHashes(published), tarballFileHashes(packed));
      // A dry run leaves pins on disk untouched, so a pin that would change
      // is content that would change.
      contentChanged = changedFiles.length > 0 || (!write && pinned.length > 0);
    }
    const decision = nextVersion({
      version,
      versionPublished,
      basePublished,
      contentChanged,
      isPublished: (candidate) => view(`${name}@${candidate}`, "version").found,
    });
    say(`${name}@${version}: published=${versionPublished} base=${basePublished} changed=${contentChanged} -> ${decision.action} ${decision.version} (${decision.reason})`);
    if (changedFiles.length) say(`  differs in ${changedFiles.join(", ")}`);
    let integrity = integrityOf(packed);
    if (decision.action === "bump" && write) {
      const written = applyVersion(root, key, decision.version);
      say(`rewrote ${written.join(", ")}`);
      run(npm, ["run", "build", "--workspace", name]);
      integrity = integrityOf(pack(key, join(scratch, key, "final")));
    }
    decided[key] = {
      version: decision.version,
      // A dry run cannot know the integrity of a tarball it did not write.
      integrity: decision.action === "bump" && !write ? "sha512-pending" : integrity,
      action: decision.action,
    };
    plan.push({
      key,
      name,
      from: version,
      to: decision.version,
      action: decision.action,
      reason: decision.reason,
      pinned,
      changedFiles,
    });
  }
  if (write && plan.some((row) => row.action === "bump" || row.pinned.length)) {
    // Pins now name workspace versions, so npm links the workspaces and drops
    // the nested registry copies the old pins installed.
    run(npm, ["install", "--package-lock-only", "--no-audit", "--no-fund"]);
  }
  if (write) {
    // The root Claude marketplace is generated from the package identity.
    run(process.execPath, ["scripts/sync-root-discovery.mjs", "--write"]);
    run(process.execPath, ["scripts/sync-import-metadata.mjs", "--write"]);
    run(process.execPath, ["scripts/validate-contract-copies.mjs"]);
    run(process.execPath, ["scripts/validate-workflows.mjs"]);
  }
  const changed = plan.filter((row) => row.action !== "none").map((row) => row.key);
  say(`\nstaging bump plan (${write ? "written" : "dry run"}):`);
  for (const row of plan) {
    say(`  ${row.key.padEnd(16)} ${row.name}@${row.from} -> ${row.to}  ${row.action}`);
  }
  say(`changed: ${changed.join(" ") || "(none)"}`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `changed=,${changed.join(",")},\n`);
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `bumped=${plan.some((row) => row.action === "bump" || row.pinned.length)}\n`,
    );
  }
  mkdirSync(scratch, { recursive: true });
  writeJson(join(scratch, "plan.json"), plan);
  return plan;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const write = process.argv.includes("--write");
  const dryRun = process.argv.includes("--dry-run");
  assert.ok(write !== dryRun, "pass exactly one of --write or --dry-run");
  await stagingBump({ write });
}
