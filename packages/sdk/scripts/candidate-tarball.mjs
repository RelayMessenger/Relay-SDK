// Test-only candidate wiring. Never imported by the shipped SDK.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

/** Opt-in only. A local candidate is not evidence that registry dependencies work. */
export function candidateTarball({ name, version, variable, env = process.env }) {
  const path = env[variable];
  if (path === undefined) return undefined;
  assert.ok(isAbsolute(path) && path.endsWith(".tgz"), `${variable} must be an absolute .tgz file`);
  assert.ok(lstatSync(path).isFile(), `${variable} must be a regular archive, not a workspace link`);
  const manifest = JSON.parse(execFileSync("tar", ["-xOf", path, "package/package.json"], { encoding: "utf8" }));
  assert.equal(manifest.name, name, `${variable} has the wrong package identity`);
  if (version !== undefined) assert.equal(manifest.version, version, `${variable} must match the consumer's declared dependency version`);
  const integrity = `sha512-${createHash("sha512").update(readFileSync(path)).digest("base64")}`;
  const candidate = { name, version: manifest.version, path, integrity };
  console.log(JSON.stringify({ validationMode: "local-candidate-not-registry", ...candidate }));
  return candidate;
}

/** Only a disposable consumer's manifest is changed; published manifests stay intact. */
export function candidateConsumerManifest(manifest, candidates) {
  return {
    ...manifest,
    dependencies: { ...manifest.dependencies, ...Object.fromEntries(candidates.map(c => [c.name, `file:${c.path}`])) },
    overrides: { ...manifest.overrides, ...Object.fromEntries(candidates.map(c => [c.name, `$${c.name}`])) },
  };
}

/** Prove the consuming package actually resolves the retained archive, not registry/nested SDK bytes. */
export function assertInstalledCandidate(consumer, importer, candidate, { lockPath = join(consumer, "package-lock.json") } = {}) {
  const require = createRequire(resolve(importer));
  const manifestPath = require.resolve(`${candidate.name}/package.json`);
  const directory = dirname(manifestPath);
  assert.ok(!lstatSync(directory).isSymbolicLink(), "candidate must be installed from a tarball, not symlinked source");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.name, candidate.name);
  assert.equal(manifest.version, candidate.version);
  // Node resolves through symlinked ancestors (macOS keeps its temporary
  // directories under /private), so compare canonical paths, not spellings.
  const key = relative(realpathSync(consumer), realpathSync(directory)).replaceAll("\\", "/");
  assert.ok(key.startsWith("node_modules/"), "candidate must resolve inside the isolated consumer");
  // A workspace overlay may retain its install receipt outside the source
  // checkout so the historical checked-in lock remains unchanged.
  assert.ok(isAbsolute(lockPath), "candidate install lock must be an absolute path");
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  assert.equal(lock.packages[key]?.integrity, candidate.integrity, "installed dependency must have the candidate archive integrity");
  const entry = manifest.main;
  assert.ok(typeof entry === "string" && !isAbsolute(entry) && !entry.split("/").includes(".."));
  const packedEntry = execFileSync("tar", ["-xOf", candidate.path, `package/${entry.replace(/^\.\//u, "")}`]);
  assert.deepEqual(readFileSync(join(directory, entry)), packedEntry, "installed entry differs from retained candidate");
}
