import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RELAY_V1_OPERATIONS } from "@relaymessenger/sdk";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");
const packageJson = JSON.parse(read("package.json"));
const sourceManifest = JSON.parse(read("SOURCE.json"));
const sourceLock = JSON.parse(
  readFileSync(join(root, "../..", "sources.lock.json"), "utf8"),
);
const manifest = JSON.parse(read("openclaw.plugin.json"));
const contractLock = JSON.parse(read("contracts/relay-v1.lock.json"));
const sdkRegistryReceipt = JSON.parse(
  read(contractLock.relaySdk.registryReceipt),
);
const require = createRequire(import.meta.url);
const sdkPackagePath = require.resolve("@relaymessenger/sdk/package.json");
const sdkTypes = readFileSync(
  join(dirname(sdkPackagePath), "dist", "types.d.ts"),
  "utf8",
);

function sourceFiles() {
  return readdirSync(join(root, "src"))
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .sort();
}

const openapiPath =
  process.env.RELAY_OPENAPI_PATH
  ?? join(root, "contracts", "relay-openapi.yaml");

test("pins the requested OpenClaw and current Relay SDK contracts", () => {
  assert.equal(packageJson.name, "@relaymessenger/openclaw-plugin");
  assert.equal(packageJson.version, "0.4.0-staging.3");
  assert.equal(packageJson.devDependencies.openclaw, "2026.8.1");
  assert.equal(packageJson.openclaw.build.openclawVersion, "2026.8.1");
  assert.equal(packageJson.dependencies["@relaymessenger/sdk"], "0.3.0-staging.7");
  assert.equal(packageJson.publishConfig.tag, "staging");
  assert.match(packageJson.openclaw.compat.pluginApi, /^>=2026\.8\.1/);
  assert.deepEqual(packageJson.repository, {
    type: "git",
    url: "git+https://github.com/RelayMessenger/Relay-SDK.git",
    directory: "packages/openclaw",
  });
  assert.deepEqual(packageJson.bugs, {
    url: "https://github.com/RelayMessenger/Relay-SDK/issues",
  });
  assert.deepEqual(sourceManifest, {
    ...sourceLock.imports["packages/openclaw"],
    imported_at: "2026-09-01",
    canonical: "Relay-SDK",
  });
});

test("binds Server, OpenAPI, and exact SDK artifact provenance", () => {
  assert.deepEqual(contractLock.relayServer, {
    repository: "RelayMessenger/Relay-Server",
    commit: "4506b8cb6f41da0b39f3e23a285daf3805fcf3a3",
    openapiPath: "contracts/developer/openapi.yaml",
    sha256: "e58ffd5de05250a7a218735cb6bffd854d2d1198134f3f8876b2be109f606fde",
  });
  assert.equal(
    contractLock.relaySdk.source.commit,
    "ddb78e385800d82b041441698985fafab3d9aba9",
  );
  assert.equal(
    contractLock.relaySdk.workspaceOpenapiSha256,
    contractLock.relayServer.sha256,
  );
  assert.equal(
    contractLock.relaySdk.source.carriedOpenapiSha256,
    sdkRegistryReceipt.source.contractSha256,
  );
  const installedSdk = JSON.parse(
    readFileSync(sdkPackagePath, "utf8"),
  );
  const installedSdkSource = JSON.parse(
    readFileSync(join(root, "..", "sdk", "SOURCE.json"), "utf8"),
  );
  assert.equal(installedSdk.version, contractLock.relaySdk.version);
  assert.equal(
    installedSdkSource.commit,
    sourceLock.imports["packages/sdk"].commit,
  );
  assert.equal(
    sdkRegistryReceipt.registry.dist.integrity,
    contractLock.relaySdk.integrity,
  );
  assert.equal(
    sdkRegistryReceipt.source.commit,
    contractLock.relaySdk.source.commit,
  );
  assert.equal(
    sdkRegistryReceipt.provenanceBoundary.registryGitHead,
    null,
  );
  assert.deepEqual(
    sdkRegistryReceipt.provenanceBoundary.registryAttestations,
    {
      url: "https://registry.npmjs.org/-/npm/v1/attestations/@relaymessenger%2fsdk@0.3.0-staging.7",
      provenance: {
        predicateType: "https://slsa.dev/provenance/v1",
      },
    },
  );
  assert.equal(
    sdkRegistryReceipt.provenanceBoundary.attestationJsonSha256,
    "b74a2b6125fd1a23353c850ab1f0cb58ad00cdc3308b511100009a44d099faed",
  );
  assert.equal(
    sdkRegistryReceipt.provenanceBoundary.slsa.resolvedDependency.digest.gitCommit,
    contractLock.relaySdk.source.commit,
  );
  assert.match(
    sdkRegistryReceipt.provenanceBoundary.claim,
    /SLSA statement binds the published tarball digest/u,
  );
  assert.equal(
    createHash("sha256")
      .update(JSON.stringify(RELAY_V1_OPERATIONS))
      .digest("hex"),
    contractLock.relaySdk.operationsSha256,
  );
});

test("binds every used REST operation and WebSocket frame to the packed SDK", () => {
  for (const expected of contractLock.relaySdk.usedOperations) {
    assert.ok(
      RELAY_V1_OPERATIONS.some(
        (operation) =>
          operation.method === expected.method &&
          operation.path === expected.path &&
          operation.operationId === expected.operationId,
      ),
      `Relay SDK is missing used operation ${expected.operationId}`,
    );
  }

  const usedFrames = [
    ...contractLock.relaySdk.usedWebSocketFrames.serverToSdk,
    ...contractLock.relaySdk.usedWebSocketFrames.sdkToServer,
  ];
  assert.deepEqual([...new Set(usedFrames)].sort(), [
    "ack",
    "disconnect",
    "error",
    "event",
    "full_sync",
    "full_sync_complete",
    "ping",
    "pong",
    "ready",
  ]);
  for (const frame of usedFrames) {
    const typeName = frame
      .split("_")
      .map((part) => `${part[0].toUpperCase()}${part.slice(1)}`)
      .join("");
    assert.match(
      sdkTypes,
      new RegExp(`interface WebSocket${typeName}Frame\\b`, "u"),
      `packed SDK is missing ${frame} frame`,
    );
  }
  assert.match(sdkTypes, /mention\?: string \| null/u);
  assert.match(sdkTypes, /owner_handle\?: ChatHandle \| null/u);
  assert.match(sdkTypes, /\bimage_url: string \| null;/u);
  assert.match(sdkTypes, /\babout: string \| null;/u);
  assert.doesNotMatch(sdkTypes, /\bavatar_url\b/u);
  assert.doesNotMatch(sdkTypes, /\btagline\b/u);
});

test("hashes the mandatory canonical OpenAPI bytes against the lock", () => {
  assert.ok(existsSync(openapiPath));
  if (process.env.RELAY_SERVER_SOURCE_DIR) {
    const serverHead = execFileSync(
      "git",
      [
        "-C",
        process.env.RELAY_SERVER_SOURCE_DIR,
        "rev-parse",
        "HEAD",
      ],
      { encoding: "utf8" },
    ).trim();
    assert.equal(serverHead, contractLock.relayServer.commit);
    const committedOpenapi = execFileSync(
      "git",
      [
        "-C",
        process.env.RELAY_SERVER_SOURCE_DIR,
        "show",
        `${contractLock.relayServer.commit}:${contractLock.relayServer.openapiPath}`,
      ],
    );
    assert.deepEqual(readFileSync(openapiPath), committedOpenapi);
  } else {
    assert.equal(
      resolve(openapiPath),
      join(root, "contracts", "relay-openapi.yaml"),
    );
  }
  const digest = createHash("sha256")
    .update(readFileSync(openapiPath))
    .digest("hex");
  assert.equal(digest, contractLock.relayServer.sha256);
});

test("declares a native channel entry, setup entry, ingress monitor, and message adapter", () => {
  assert.match(read("index.ts"), /defineChannelPluginEntry/u);
  assert.match(read("setup-entry.ts"), /defineSetupPluginEntry/u);
  assert.match(read("src/ingress.ts"), /createStandardRawEventIngressMonitor/u);
  assert.match(read("src/channel.ts"), /defineChannelMessageAdapter/u);
  assert.deepEqual(manifest.channels, ["relay"]);
  assert.equal(manifest.activation.onStartup, false);
});

test("uses the SDK WebSocket for ingress and SDK REST resources for sends", () => {
  assert.match(read("src/gateway.ts"), /relay\.websocket\.run/u);
  assert.match(read("src/gateway.ts"), /onFullSync/u);
  assert.match(read("src/gateway.ts"), /webhookSubscriptions\.list/u);
  assert.match(read("src/outbound.ts"), /relay\.chats\.messages\.send/u);
  assert.match(read("src/dispatch.ts"), /relay\.messages\.retrieve/u);
  assert.doesNotMatch(read("src/outbound.ts"), /\bfetch\s*\(/u);
});

test("contains no removed long-poll, Conversation, agents-me, or copied client code", () => {
  const files = sourceFiles();
  assert.ok(!files.includes("client.ts"));
  assert.ok(!files.includes("poll-loop.ts"));
  assert.ok(!files.some((name) => name.includes("cursor")));
  const source = files.map((name) => read(`src/${name}`)).join("\n");
  for (const forbidden of [
    "/v1/events",
    "pollEvents",
    "pollTimeout",
    "/v1/conversations",
    "conversation_id",
    "/v1/agents/me",
    "getMe(",
    "vendor/relay-sdk",
  ]) {
    assert.ok(!source.includes(forbidden), `found removed contract: ${forbidden}`);
  }
});

test("distinguishes native OpenClaw capability and ingress timing from removed Relay effects and polling", () => {
  const channel = read("src/channel.ts");
  const ingress = read("src/ingress.ts");
  const transport = `${read("src/gateway.ts")}\n${read("src/outbound.ts")}`;
  assert.match(channel, /effects:\s*false/u);
  assert.match(ingress, /pollIntervalMs/u);
  assert.match(ingress, /createStandardRawEventIngressMonitor/u);
  assert.doesNotMatch(transport, /\/v1\/events|pollEvents|runPollLoop/u);
  assert.doesNotMatch(
    read("src/outbound.ts"),
    /addEffect|removeEffect|message\.effect/iu,
  );
});

test("uses Relay Contact, Handle, Chat, and Message vocabulary in public docs", () => {
  const publicText = `${read("README.md")}\n${read("openclaw.plugin.json")}`;
  for (const required of ["Contact", "Handle", "Chat", "Message"]) {
    assert.match(publicText, new RegExp(`\\b${required}s?\\b`, "u"));
  }
  assert.doesNotMatch(publicText, /\bconversation(s)?\b/iu);
});

test("built entry and setup entry load on the exact OpenClaw runtime", async () => {
  const full = await import(join(root, "dist", "index.js"));
  const setup = await import(join(root, "dist", "setup-entry.js"));
  assert.equal(full.default.id, "relay");
  assert.equal(full.default.channelPlugin.id, "relay");
  assert.equal(full.default.channelPlugin.message.id, "relay");
  assert.equal(setup.default.plugin.id, "relay");
});

test("keeps the package release guard monorepo-bound and staging-only", () => {
  const guard = read("scripts/staging-release-guard.mjs");
  assert.match(guard, /GITHUB_REPOSITORY/u);
  assert.match(guard, /GITHUB_WORKSPACE/u);
  assert.match(guard, /RelayMessenger\/Relay-SDK/u);
  assert.match(guard, /packages\/openclaw/u);
  assert.match(guard, /refs\/heads\/staging/u);
  assert.match(guard, /workflowSha,\s*releaseSha/u);
  assert.match(guard, /releaseTag,\s*"staging"/u);
  assert.match(guard, /tag:\s*"staging"/u);
  assert.match(guard, /provenance:\s*true/u);
  assert.match(
    read("scripts/verify-contract-provenance.mjs"),
    /contracts", "relay-openapi\.yaml/u,
  );
  assert.match(
    read("scripts/release-validate.mjs"),
    /relay-openclaw-release-validation\/v1/u,
  );
});
