import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Binds this plugin to one Relay Server contract and one exact SDK tarball.
//
// The SDK binding is the tarball's own sha512, the value npm records as
// dist.integrity: fetched from the packument, then re-derived by downloading
// and hashing the tarball. Production publishes carry no npm attestation
// (Blacksmith runners, owner ruling 2026-09-07), so there is no SLSA
// statement to bind to; the bytes are the receipt.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (path) =>
  JSON.parse(readFileSync(join(root, path), "utf8"));
const lock = readJson("contracts/relay-v1.lock.json");
const sourceLock = readJson("../../sources.lock.json");
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
      "user-agent": "relay-openclaw-contract-verifier/2",
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
    "canonical OpenAPI differs from the locked Server commit",
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
const workspaceOpenapi = readFileSync(
  join(root, "..", "..", "contracts", "relay-v1-openapi.yaml"),
);
assert.deepEqual(openapi, workspaceOpenapi);
assert.equal(
  digest("sha256", workspaceOpenapi),
  lock.relaySdk.workspaceOpenapiSha256,
);
assert.equal(lock.relaySdk.workspaceOpenapiSha256, lock.relayServer.sha256);

assert.equal(lock.relaySdk.package, "@relaymessenger/sdk");
assert.match(lock.relaySdk.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/u);
const packumentUrl =
  `https://registry.npmjs.org/${lock.relaySdk.package.replace("/", "%2f")}`;
const packument = JSON.parse(
  (await fetchOk(packumentUrl, "npm packument")).toString("utf8"),
);
const registryVersion = packument.versions?.[lock.relaySdk.version];
assert.ok(registryVersion, `locked SDK ${lock.relaySdk.version} is absent from npm`);
assert.equal(registryVersion.name, lock.relaySdk.package);
assert.equal(
  registryVersion.dist?.integrity,
  lock.relaySdk.integrity,
  "npm dist.integrity differs from the locked SDK tarball",
);
const registryTarball = await fetchOk(
  registryVersion.dist.tarball,
  "npm SDK tarball",
);
assert.equal(
  `sha512-${digest("sha512", registryTarball, "base64")}`,
  lock.relaySdk.integrity,
  "downloaded SDK tarball does not hash to the locked integrity",
);
const packedManifest = JSON.parse(
  execFileSync("tar", ["-xOzf", "-", "package/package.json"], {
    input: registryTarball,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  }),
);
assert.equal(packedManifest.name, lock.relaySdk.package);
assert.equal(packedManifest.version, lock.relaySdk.version);

// During release preparation the SDK workspace may be a new unpublished
// version. npm then installs OpenClaw's still-published exact dependency
// beside it. Verify what resolved, not where it lives.
const installedPackagePath = require.resolve("@relaymessenger/sdk/package.json");
const installedSource = JSON.parse(
  readFileSync(join(root, "..", "sdk", "SOURCE.json"), "utf8"),
);
assert.equal(
  installedSource.commit,
  sourceLock.imports["packages/sdk"].commit,
  "SDK SOURCE.json must retain the imported upstream commit",
);
const installedPackage = JSON.parse(readFileSync(installedPackagePath, "utf8"));
assert.equal(installedPackage.version, lock.relaySdk.version);
const installedTypes = readFileSync(
  join(dirname(installedPackagePath), "dist", "types.d.ts"),
  "utf8",
);
assert.match(installedTypes, /\bimage_url: string \| null;/u);
assert.match(installedTypes, /\babout: string \| null;/u);
assert.doesNotMatch(installedTypes, /\bavatar_url\b/u);
assert.doesNotMatch(installedTypes, /\btagline\b/u);

console.log(
  JSON.stringify({
    ok: true,
    server: {
      commit: serverHead,
      openapiSha256: digest("sha256", openapi),
      verification: serverVerification,
    },
    sdk: {
      version: lock.relaySdk.version,
      registryIntegrity: lock.relaySdk.integrity,
      registryTarballSha256: digest("sha256", registryTarball),
      publishedAt: packument.time?.[lock.relaySdk.version] ?? null,
      claim: "registry integrity and downloaded tarball bytes match the lock",
    },
  }),
);
