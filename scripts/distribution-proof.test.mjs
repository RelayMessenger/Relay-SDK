import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { assertSearchOrigin } from "../tooling/skills-distributions/src/distribution/scripts/mcp-client.mjs";
import { verifyContractLock } from "../tooling/skills-distributions/src/distribution/scripts/verify-contract-lock.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");
function fixture() {
  const lock = {
    api: {
      repository: "https://github.com/RelayMessenger/Relay-Server",
      commit: "private-origin",
      openapi_path: "private.yaml",
      openapi_sha256: digest("public contract"),
      public_source: {
        repository: "https://github.com/RelayMessenger/Relay-SDK",
        commit: "public-pin",
        path: "contracts/relay-v1-openapi.yaml",
      },
    },
    docs: {
      repository: "https://github.com/RelayMessenger/Relay-Docs",
      commit: "docs-pin",
      skill_path: "skill.md",
      skill_sha256: digest("docs skill"),
    },
    sdk: {
      repository: "https://github.com/RelayMessenger/Relay-SDK",
      commit: "sdk-pin",
      package_path: "packages/sdk/package.json",
      package_sha256: digest("sdk manifest"),
      version: "0.3.1-staging.1",
      dist_tag: "staging",
      integrity: "sha512-locked",
    },
  };
  const metadata = {
    "dist-tags": { staging: "0.3.3-staging.6" },
    versions: { [lock.sdk.version]: { dist: { integrity: lock.sdk.integrity } } },
  };
  const files = new Map([
    ["https://raw.githubusercontent.com/RelayMessenger/Relay-SDK/public-pin/contracts/relay-v1-openapi.yaml", "public contract"],
    ["https://raw.githubusercontent.com/RelayMessenger/Relay-Docs/docs-pin/skill.md", "docs skill"],
    ["https://raw.githubusercontent.com/RelayMessenger/Relay-SDK/sdk-pin/packages/sdk/package.json", "sdk manifest"],
  ]);
  const requests = [];
  const fetchSource = async (url) => {
    requests.push(url);
    if (url === "https://registry.npmjs.org/@relaymessenger%2Fsdk") return Response.json(metadata);
    assert.ok(files.has(url), `unexpected source request: ${url}`);
    return new Response(files.get(url));
  };
  return { lock, metadata, files, requests, fetchSource };
}

test("a lock uses the public contract and survives a newer staging tag", async () => {
  const f = fixture();
  await verifyContractLock(f.lock, f.fetchSource);
  assert.equal(f.requests.length, 4);
  assert.ok(f.requests.every((url) => !url.includes("Relay-Server")));
});

for (const path of ["contracts/relay-v1-openapi.yaml", "skill.md", "packages/sdk/package.json"]) {
  test(`the lock rejects changed source bytes: ${path}`, async () => {
    const f = fixture();
    const url = [...f.files.keys()].find((entry) => entry.endsWith(`/${path}`));
    f.files.set(url, "changed");
    await assert.rejects(verifyContractLock(f.lock, f.fetchSource), { code: "ERR_ASSERTION" });
  });
}

test("the lock rejects a missing immutable SDK version", async () => {
  const f = fixture();
  delete f.metadata.versions[f.lock.sdk.version];
  await assert.rejects(verifyContractLock(f.lock, f.fetchSource), /is not published/);
});

test("the lock rejects changed registry integrity", async () => {
  const f = fixture();
  f.metadata.versions[f.lock.sdk.version].dist.integrity = "sha512-changed";
  await assert.rejects(verifyContractLock(f.lock, f.fetchSource), /integrity drifted/);
});

test("the lock rejects a missing public contract pin", async () => {
  const f = fixture();
  delete f.lock.api.public_source;
  await assert.rejects(verifyContractLock(f.lock, f.fetchSource), { code: "ERR_ASSERTION" });
});

test("MCP links follow the configured docs origin, not the production host", () => {
  const staging = "https://docs.staging.relayapp.im/mcp";
  assertSearchOrigin("Link: https://docs.staging.relayapp.im/live/authentication", staging);
  assert.throws(() => assertSearchOrigin("Link: https://docs.relayapp.im/authentication", staging));
  assert.throws(() => assertSearchOrigin("Link: https://docs.staging.relayapp.im.evil.test/auth", staging));
  assertSearchOrigin("Link: https://docs.relayapp.im/authentication", "https://docs.relayapp.im/mcp");
});
