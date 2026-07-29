import assert from "node:assert/strict";
import test from "node:test";

import { verifyNpmRegistryIntegrity } from "./verify-npm-registry-integrity.mjs";

const packageSpec = "@relaymessenger/example@1.2.3";
const expectedIntegrity = "sha512-YWJj";

test("retries propagation E404 responses until integrity is available", async () => {
  const results = [
    { error: "npm error code E404\nnpm error 404 No match found for version 1.2.3" },
    { error: "npm error code E404\nnpm error 404 No match found for version 1.2.3" },
    { integrity: expectedIntegrity },
  ];
  const sleeps = [];
  const logs = [];

  const actual = await verifyNpmRegistryIntegrity({
    packageSpec,
    expectedIntegrity,
    maxAttempts: 3,
    retryDelayMs: 25,
    query: () => results.shift(),
    sleep: async (delay) => sleeps.push(delay),
    log: (message) => logs.push(message),
  });

  assert.equal(actual, expectedIntegrity);
  assert.deepEqual(sleeps, [25, 25]);
  assert.equal(logs.length, 3);
});

test("fails immediately on an integrity mismatch", async () => {
  let queries = 0;
  await assert.rejects(
    verifyNpmRegistryIntegrity({
      packageSpec,
      expectedIntegrity,
      maxAttempts: 4,
      retryDelayMs: 0,
      query: () => {
        queries += 1;
        return { integrity: "sha512-ZGVm" };
      },
      sleep: async () => {
        throw new Error("must not sleep");
      },
      log: () => {},
    }),
    /registry integrity sha512-ZGVm != retained artifact sha512-YWJj/u,
  );
  assert.equal(queries, 1);
});

test("fails immediately on non-E404 npm errors", async () => {
  let queries = 0;
  await assert.rejects(
    verifyNpmRegistryIntegrity({
      packageSpec,
      expectedIntegrity,
      maxAttempts: 4,
      retryDelayMs: 0,
      query: () => {
        queries += 1;
        return { error: "npm error code E401\nnpm error Incorrect or missing password." };
      },
      sleep: async () => {
        throw new Error("must not sleep");
      },
      log: () => {},
    }),
    /npm view failed.*E401/su,
  );
  assert.equal(queries, 1);
});

test("fails after the bounded E404 propagation window", async () => {
  let queries = 0;
  await assert.rejects(
    verifyNpmRegistryIntegrity({
      packageSpec,
      expectedIntegrity,
      maxAttempts: 3,
      retryDelayMs: 0,
      query: () => {
        queries += 1;
        return { error: "npm error code E404\nnpm error 404 No match found" };
      },
      sleep: async () => {},
      log: () => {},
    }),
    /did not expose .* after 3 attempts/su,
  );
  assert.equal(queries, 3);
});
