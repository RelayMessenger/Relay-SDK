import assert from "node:assert/strict";
import test from "node:test";
import {
  findForbiddenTrackedFiles,
  validateTrackedGeneratedArtifacts,
} from "./validate-generated-artifacts.mjs";

test("allows canonical OpenAPI spec and intentional plugin bundle", () => {
  assert.deepEqual(
    findForbiddenTrackedFiles([
      "contracts/relay-v1-openapi.yaml",
      "packages/claude-code/plugin/runtime/server.mjs",
      "packages/think/src/worker.ts",
    ]),
    [],
  );
});

test("rejects committed worker-configuration.d.ts, duplicate OpenAPI specs, and generated claude-code runtime", () => {
  const violations = findForbiddenTrackedFiles([
    "worker-configuration.d.ts",
    "packages/think/worker-configuration.d.ts",
    "cookbook/cloudflare-think-agent/worker-configuration.d.ts",
    "packages/chat-sdk-adapter/contracts/relay-openapi.yaml",
    "relay-openapi.yaml",
    "packages/sdk/contracts/relay-v1-openapi.yaml",
    "packages/claude-code/runtime/server.mjs",
  ]);
  assert.equal(violations.length, 7);
  assert.match(violations[0], /worker-configuration\.d\.ts/);
  assert.match(violations[3], /relay-openapi\.yaml/);
  assert.match(violations[5], /relay-v1-openapi\.yaml/);
  assert.match(violations[6], /packages\/claude-code\/runtime\/server\.mjs/);
});

test("current repository tracks no forbidden generated or duplicate artifacts", () => {
  assert.ok(validateTrackedGeneratedArtifacts() > 0);
});
