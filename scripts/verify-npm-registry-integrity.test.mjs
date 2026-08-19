import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  parseNpmViewIntegrity,
  verifyNpmRegistryIntegrity,
} from "./verify-npm-registry-integrity.mjs";

const packageSpec = "@relaymessenger/example@1.2.3";
const expectedIntegrity = "sha512-YWJj";

test("accepts npm 10 string and npm 12 single-field array output", () => {
  assert.equal(
    parseNpmViewIntegrity(JSON.stringify(expectedIntegrity)),
    expectedIntegrity,
  );
  assert.equal(
    parseNpmViewIntegrity(JSON.stringify([expectedIntegrity])),
    expectedIntegrity,
  );
});

test("rejects ambiguous npm view integrity output", () => {
  assert.throws(
    () => parseNpmViewIntegrity(JSON.stringify([expectedIntegrity, expectedIntegrity])),
    /unexpected integrity shape/u,
  );
  assert.throws(
    () => parseNpmViewIntegrity(JSON.stringify({ integrity: expectedIntegrity })),
    /unexpected integrity shape/u,
  );
});

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

test("runs the CLI entrypoint even when invoked through a symlink", () => {
  const temp = mkdtempSync(join(tmpdir(), "npm-registry-verifier-symlink-"));
  try {
    const link = join(temp, "verify.mjs");
    symlinkSync(
      fileURLToPath(new URL("./verify-npm-registry-integrity.mjs", import.meta.url)),
      link,
      "file",
    );
    const result = spawnSync(process.execPath, [link], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(
      `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
      /usage: verify-npm-registry-integrity\.mjs/u,
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
