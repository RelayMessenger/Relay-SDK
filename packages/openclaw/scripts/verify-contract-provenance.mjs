import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import {
  dirname,
  join,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (path) =>
  JSON.parse(readFileSync(join(root, path), "utf8"));
const lock = readJson("contracts/relay-v1.lock.json");
const sourceLock = readJson("../../sources.lock.json");
const receipt = readJson(lock.relaySdk.registryReceipt);
const require = createRequire(import.meta.url);

function digest(algorithm, value, encoding = "hex") {
  return createHash(algorithm).update(value).digest(encoding);
}

async function fetchOk(url, label) {
  const response = await fetch(url, {
    headers: {
      accept: label === "npm packument"
        ? "application/json"
        : "application/octet-stream",
      "user-agent": "relay-openclaw-contract-verifier/1",
    },
  });
  assert.equal(
    response.status,
    200,
    `${label} fetch failed with HTTP ${response.status}`,
  );
  return Buffer.from(await response.arrayBuffer());
}

const serverSourceDir = process.env.RELAY_SERVER_SOURCE_DIR;
const openapiPath =
  process.env.RELAY_OPENAPI_PATH
  ?? join(root, "contracts", "relay-openapi.yaml");

const canonicalOpenapiPath = realpathSync(openapiPath);
const openapi = readFileSync(canonicalOpenapiPath);
let serverHead = lock.relayServer.commit;
let serverVerification = "locked-fixture";
if (serverSourceDir) {
  const canonicalSourceDir = realpathSync(serverSourceDir);
  assert.equal(
    canonicalOpenapiPath,
    realpathSync(join(canonicalSourceDir, lock.relayServer.openapiPath)),
    "RELAY_OPENAPI_PATH must be the locked path in RELAY_SERVER_SOURCE_DIR",
  );
  serverHead = execFileSync(
    "git",
    ["-C", canonicalSourceDir, "rev-parse", "HEAD"],
    { encoding: "utf8" },
  ).trim();
  assert.equal(
    serverHead,
    lock.relayServer.commit,
    "Relay-Server checkout is not the locked commit",
  );
  const committedOpenapi = execFileSync(
    "git",
    [
      "-C",
      canonicalSourceDir,
      "show",
      `${lock.relayServer.commit}:${lock.relayServer.openapiPath}`,
    ],
    { maxBuffer: 10 * 1024 * 1024 },
  );
  assert.deepEqual(
    openapi,
    committedOpenapi,
    "checked-out OpenAPI bytes differ from the locked Server commit",
  );
  serverVerification = "exact-checkout";
} else {
  assert.equal(
    canonicalOpenapiPath,
    realpathSync(join(root, "contracts/relay-openapi.yaml")),
    "public CI must verify the checked-in canonical OpenAPI fixture",
  );
}
assert.equal(
  digest("sha256", openapi),
  lock.relayServer.sha256,
  "canonical Relay OpenAPI hash drifted",
);

assert.equal(receipt.source.commit, lock.relaySdk.source.commit);
assert.equal(
  receipt.source.contractSha256,
  lock.relaySdk.source.carriedOpenapiSha256,
);
assert.equal(receipt.registry.package, lock.relaySdk.package);
assert.equal(receipt.registry.version, lock.relaySdk.version);
assert.equal(receipt.registry.dist.integrity, lock.relaySdk.integrity);

const sdkSourceBase =
  `https://raw.githubusercontent.com/${receipt.source.repository}` +
  `/${receipt.source.commit}`;
const sdkSourcePackage = await fetchOk(
  `${sdkSourceBase}/${receipt.source.packageJsonPath}`,
  "Relay-SDK package.json",
);
const sdkSourceContract = await fetchOk(
  `${sdkSourceBase}/${receipt.source.contractPath}`,
  "Relay-SDK carried OpenAPI",
);
assert.equal(
  digest("sha256", sdkSourcePackage),
  receipt.source.packageJsonSha256,
  "Relay-SDK source package.json hash drifted",
);
assert.equal(
  digest("sha256", sdkSourceContract),
  receipt.source.contractSha256,
  "Relay-SDK carried OpenAPI hash drifted",
);
const sdkSourceManifest = JSON.parse(sdkSourcePackage.toString("utf8"));
assert.equal(sdkSourceManifest.name, receipt.registry.package);
assert.equal(sdkSourceManifest.version, receipt.registry.version);
assert.deepEqual(
  sdkSourceManifest.repository,
  receipt.registry.repository,
);
assert.deepEqual(
  sdkSourceManifest.publishConfig,
  receipt.registry.publishConfig,
);

const packument = JSON.parse(
  (
    await fetchOk(receipt.registry.packumentUrl, "npm packument")
  ).toString("utf8"),
);
const registryVersion = packument.versions?.[receipt.registry.version];
assert.ok(registryVersion, "locked SDK version is absent from npm");
assert.equal(registryVersion.name, receipt.registry.package);
assert.equal(registryVersion.version, receipt.registry.version);
assert.equal(
  packument.time?.[receipt.registry.version],
  receipt.registry.publishedAt,
);
assert.deepEqual(registryVersion.repository, receipt.registry.repository);
assert.deepEqual(
  registryVersion.publishConfig,
  receipt.registry.publishConfig,
);
assert.equal(
  receipt.registry.distTagsObserved.mutable,
  true,
  "registry receipt must identify npm dist-tags as mutable observations",
);
assert.equal(registryVersion.dist?.tarball, receipt.registry.dist.tarball);
assert.equal(
  registryVersion.dist?.integrity,
  receipt.registry.dist.integrity,
);
assert.equal(registryVersion.dist?.shasum, receipt.registry.dist.shasum);
assert.equal(
  registryVersion.dist?.fileCount,
  receipt.registry.dist.fileCount,
);
assert.equal(
  registryVersion.dist?.unpackedSize,
  receipt.registry.dist.unpackedSize,
);
assert.deepEqual(
  registryVersion.dist?.signatures,
  receipt.registry.dist.signatureMetadata,
);
assert.equal(
  registryVersion.gitHead ?? null,
  receipt.provenanceBoundary.registryGitHead,
);
assert.deepEqual(
  registryVersion.dist?.attestations ?? null,
  receipt.provenanceBoundary.registryAttestations,
);
const attestationResponse = await fetch(
  receipt.provenanceBoundary.attestationEndpoint,
  {
    headers: {
      accept: "application/json",
      "user-agent": "relay-openclaw-contract-verifier/1",
    },
  },
);
assert.equal(
  attestationResponse.status,
  receipt.provenanceBoundary.attestationEndpointObservedStatus,
  "npm attestation availability changed; review the provenance boundary",
);

const registryTarball = await fetchOk(
  receipt.registry.dist.tarball,
  "npm SDK tarball",
);
assert.equal(registryTarball.byteLength, receipt.registry.dist.bytes);
assert.equal(
  digest("sha256", registryTarball),
  receipt.registry.dist.sha256,
);
assert.equal(digest("sha1", registryTarball), receipt.registry.dist.shasum);
assert.equal(
  `sha512-${digest("sha512", registryTarball, "base64")}`,
  receipt.registry.dist.integrity,
);
const temp = mkdtempSync(join(tmpdir(), "relay-sdk-registry-"));
try {
  const archive = join(temp, "sdk.tgz");
  writeFileSync(archive, registryTarball);
  const packedPackageJson = execFileSync(
    "tar",
    ["-xOf", archive, "package/package.json"],
    { encoding: "buffer" },
  );
  assert.equal(
    digest("sha256", packedPackageJson),
    receipt.registry.installedArtifact.packageJsonSha256,
  );
  assert.deepEqual(
    JSON.parse(packedPackageJson.toString("utf8")),
    sdkSourceManifest,
    "registry package.json differs from the locked SDK source commit",
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}

const installedPackagePath = require.resolve(
  "@relaymessenger/sdk/package.json",
);
assert.equal(
  realpathSync(installedPackagePath),
  realpathSync(join(root, "..", "sdk", "package.json")),
  "Relay-SDK monorepo validation must use the canonical SDK workspace",
);
const installedSource = JSON.parse(
  readFileSync(join(root, "..", "sdk", "SOURCE.json"), "utf8"),
);
assert.equal(
  installedSource.commit,
  sourceLock.imports["packages/sdk"].commit,
  "SDK SOURCE.json must retain the imported upstream commit",
);
const installedPackage = readFileSync(installedPackagePath);
const installedTypes = readFileSync(
  join(dirname(installedPackagePath), "dist", "types.d.ts"),
);
assert.equal(
  digest("sha256", installedPackage),
  receipt.registry.installedArtifact.packageJsonSha256,
);
assert.equal(
  digest("sha256", installedTypes),
  receipt.registry.installedArtifact.typesSha256,
);
assert.deepEqual(
  JSON.parse(installedPackage.toString("utf8")),
  sdkSourceManifest,
);

console.log(
  JSON.stringify({
    ok: true,
    server: {
      commit: serverHead,
      openapiSha256: digest("sha256", openapi),
      verification: serverVerification,
    },
    sdk: {
      sourceCommit: receipt.source.commit,
      version: receipt.registry.version,
      registryIntegrity: receipt.registry.dist.integrity,
      registryTarballSha256: receipt.registry.dist.sha256,
      publishedAt: receipt.registry.publishedAt,
      gitHead: receipt.provenanceBoundary.registryGitHead,
      attestations: receipt.provenanceBoundary.registryAttestations,
      attestationEndpointStatus: attestationResponse.status,
      claim: "registry integrity and metadata match; no source attestation claimed",
    },
  }),
);
