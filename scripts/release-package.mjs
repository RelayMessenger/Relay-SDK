// The one driver behind every tag-triggered release workflow.
//
// Everything that differs between the six packages is data in
// scripts/release-packages.mjs, so this file holds the logic once and the
// callers (scripts/release-run.mjs, the staging publish) pass `--package <key>`.
//
// Subcommands:
//   resolve         write the catalog entry to GITHUB_OUTPUT
//   check-version   assert the manifest names this package at a sane version
//   pack            pack one tarball, write a release manifest, set outputs
//   registry-state  set published=true|false so a retry never republishes
//   verify-registry install the published version clean and exercise it
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { releaseEntry } from "./release-packages.mjs";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

const valueAfter = (name) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};

const entry = releaseEntry(valueAfter("--package") ?? "");
const manifestPath = resolve(repoRoot, entry.directory, "package.json");
const pkg = JSON.parse(readFileSync(manifestPath, "utf8"));
const expectedTag = `${entry.tagPrefix}${pkg.version}`; // the record tag for THIS version
const spec = `${pkg.name}@${pkg.version}`;

const setOutput = (name, value) => {
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  }
};
const say = (message) => process.stdout.write(`${message}\n`);

function checkVersion() {
  assert.equal(
    pkg.name,
    entry.workspace,
    `${entry.directory} is ${pkg.name}, not ${entry.workspace}`,
  );
  assert.match(
    pkg.version,
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u,
    `invalid package version: ${pkg.version}`,
  );
  assert.equal(
    pkg.repository?.url,
    "git+https://github.com/RelayMessenger/Relay-SDK.git",
  );
  assert.equal(pkg.repository?.directory, entry.directory);
  say(`release identity: ${spec} from ${entry.directory}`);
}

function resolveEntry() {
  checkVersion();
  for (
    const [name, value] of Object.entries({
      key: entry.key,
      directory: entry.directory,
      workspace: entry.workspace,
      validate: entry.validate,
      manifest: `${entry.directory}/package.json`,
      tag: expectedTag,
      version: pkg.version,
    })
  ) {
    setOutput(name, value);
  }
  say(JSON.stringify({ key: entry.key, spec, tag: expectedTag }));
}

function pack(destination) {
  checkVersion();
  const outputDir = resolve(repoRoot, destination);
  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });
  const packed = spawnSync(npm, [
    "pack",
    "--workspace",
    entry.workspace,
    "--ignore-scripts",
    "--pack-destination",
    outputDir,
  ], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  assert.equal(packed.status, 0, "npm pack failed");
  const tarballs = readdirSync(outputDir).filter((name) =>
    name.endsWith(".tgz")
  );
  assert.equal(
    tarballs.length,
    1,
    `expected one tarball, packed ${tarballs.length}`,
  );
  const tarball = join(outputDir, tarballs[0]);
  const bytes = readFileSync(tarball);
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  // The packed manifest, not the working tree, is what the registry receives.
  const packedManifest = JSON.parse(
    execFileSync("tar", ["-xOzf", tarball, "package/package.json"], {
      encoding: "utf8",
    }),
  );
  assert.equal(packedManifest.name, pkg.name);
  assert.equal(packedManifest.version, pkg.version);

  const releaseManifest = {
    schemaVersion: 1,
    repository: process.env.GITHUB_REPOSITORY,
    sourceSha: process.env.GITHUB_SHA,
    tag: process.env.RELEASE_TAG,
    workflowRunId: process.env.GITHUB_RUN_ID,
    workflowRunAttempt: process.env.GITHUB_RUN_ATTEMPT,
    package: pkg.name,
    version: pkg.version,
    artifact: basename(tarball),
    size: statSync(tarball).size,
    sha256,
    integrity,
  };
  const manifestFile = join(outputDir, "release-manifest.json");
  writeFileSync(manifestFile, `${JSON.stringify(releaseManifest, null, 2)}\n`);

  const relative = (path) => path.slice(repoRoot.length + 1);
  setOutput("tarball", relative(tarball));
  setOutput("manifest", relative(manifestFile));
  setOutput("integrity", integrity);
  setOutput("sha256", sha256);
  say(`retained artifact: ${relative(tarball)}`);
  say(`sha256: ${sha256}`);
  say(`integrity: ${integrity}`);
}

const view = (target, field) => {
  const result = spawnSync(npm, [
    "view",
    target,
    field,
    "--json",
    "--registry",
    "https://registry.npmjs.org/",
  ], { cwd: repoRoot, encoding: "utf8" });
  if (result.status === 0) {
    return { found: true, stdout: result.stdout };
  }
  const detail = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (/E404|404 Not Found|is not in this registry/iu.test(detail)) {
    return { found: false };
  }
  throw new Error(
    `could not establish registry availability:\n${detail.trim()}`,
  );
};

/**
 * A retried release must never republish over a good artifact, so treat an
 * already-present version as success and let the verify steps re-prove it.
 */
function registryState() {
  checkVersion();
  const result = view(spec, "version");
  if (result.found) {
    // npm 12 answers a single match as a one-element array.
    const parsed = JSON.parse(result.stdout);
    assert.equal(Array.isArray(parsed) ? parsed[0] : parsed, pkg.version);
    setOutput("published", "true");
    say(`${spec} is already published`);
    return;
  }
  setOutput("published", "false");
  say(`${spec} is not yet published`);
}

/** Install the exact published version clean and exercise what it ships. */
async function verifyRegistry() {
  checkVersion();
  const temp = mkdtempSync(join(tmpdir(), `${entry.key}-registry-smoke-`));
  try {
    writeFileSync(
      join(temp, "package.json"),
      `${
        JSON.stringify(
          { name: "relay-registry-smoke", private: true, type: "module" },
          null,
          2,
        )
      }\n`,
    );
    let installed = false;
    let lastFailure = "";
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      const result = spawnSync(npm, [
        "install",
        "--no-audit",
        "--no-fund",
        "--prefer-online",
        spec,
      ], { cwd: temp, encoding: "utf8" });
      if (result.status === 0) {
        installed = true;
        break;
      }
      lastFailure = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
      if (attempt < 6) {
        await new Promise((wait) => setTimeout(wait, 5_000));
      }
    }
    assert.equal(
      installed,
      true,
      `registry install did not converge:\n${lastFailure}`,
    );

    const installedRoot = join(temp, "node_modules", ...pkg.name.split("/"));
    const installedPkg = JSON.parse(
      readFileSync(join(installedRoot, "package.json"), "utf8"),
    );
    assert.equal(installedPkg.version, pkg.version);

    const smoke = entry.smoke ?? {};
    for (const file of smoke.files ?? []) {
      assert.equal(
        existsSync(join(installedRoot, file)),
        true,
        `registry install is missing ${file}`,
      );
    }
    for (const file of smoke.parse ?? []) {
      const checked = spawnSync(process.execPath, [
        "--check",
        join(installedRoot, file),
      ], { cwd: temp, encoding: "utf8" });
      assert.equal(
        checked.status,
        0,
        `shipped entry failed to parse: ${file}\n${checked.stderr}`,
      );
    }
    if (smoke.manifestVersion) {
      const shipped = JSON.parse(
        readFileSync(join(installedRoot, smoke.manifestVersion), "utf8"),
      );
      assert.equal(
        shipped.version,
        pkg.version,
        `${smoke.manifestVersion} says ${shipped.version}, package says ${pkg.version}`,
      );
    }
    for (const probe of smoke.imports ?? []) {
      const file = join(temp, `probe-${probe.specifier.replaceAll(/\W/gu, "-")}.mjs`);
      writeFileSync(
        file,
        [
          `import * as loaded from ${JSON.stringify(probe.specifier)};`,
          `const required = ${JSON.stringify(probe.named ?? [])};`,
          `for (const name of required) {`,
          `  if (loaded[name] === undefined) {`,
          `    throw new Error("missing export: " + name);`,
          `  }`,
          `}`,
          ...(probe.default
            ? [
              `if (loaded.default === undefined) {`,
              `  throw new Error("missing default export");`,
              `}`,
            ]
            : []),
          `process.stdout.write("loaded ${probe.specifier}\\n");`,
        ].join("\n"),
      );
      const loaded = spawnSync(process.execPath, [file], {
        cwd: temp,
        encoding: "utf8",
      });
      assert.equal(
        loaded.status,
        0,
        `${probe.specifier} failed to load from the registry copy:\n${loaded.stderr}`,
      );
    }
    if (smoke.run) {
      const output = execFileSync(process.execPath, [
        join(installedRoot, smoke.run.entry),
        ...smoke.run.args,
      ], { cwd: temp, encoding: "utf8" });
      assert.ok(
        output.includes(smoke.run.expect),
        `${smoke.run.entry} ${smoke.run.args.join(" ")} did not print ${
          JSON.stringify(smoke.run.expect)
        }:\n${output}`,
      );
    }
    say(`registry-installed ${spec} smoke passed`);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

const command = process.argv[2];
if (command === "resolve") resolveEntry();
else if (command === "check-version") checkVersion();
else if (command === "pack") pack(valueAfter("--destination") ?? ".release-tmp");
else if (command === "registry-state") registryState();
else if (command === "verify-registry") await verifyRegistry();
else {
  throw new Error(
    "usage: release-package.mjs <resolve|check-version|pack|"
      + "registry-state|verify-registry> --package <key> "
      + "[--destination <dir>]",
  );
}
