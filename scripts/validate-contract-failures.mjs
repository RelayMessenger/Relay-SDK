import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = mkdtempSync(resolve(tmpdir(), "relay-sdk-contract-failures-"));

const validateAgainst = (source) => spawnSync(
  process.execPath,
  ["scripts/validate-contract.mjs"],
  {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      RELAY_OPENAPI_SOURCE: source,
    },
  },
);

try {
  const missing = validateAgainst(resolve(temporary, "missing.yaml"));
  assert.notEqual(missing.status, 0, "A missing OpenAPI must fail validation");
  assert.match(
    missing.stderr,
    /Relay OpenAPI is missing or unreadable/,
  );

  const directory = resolve(temporary, "not-a-file");
  mkdirSync(directory);
  const unreadable = validateAgainst(directory);
  assert.notEqual(
    unreadable.status,
    0,
    "An unreadable OpenAPI must fail validation",
  );
  assert.match(
    unreadable.stderr,
    /Relay OpenAPI is missing or unreadable/,
  );

  const mismatchedPath = resolve(temporary, "mismatched.yaml");
  writeFileSync(mismatchedPath, "openapi: 3.1.0\n");
  const mismatched = validateAgainst(mismatchedPath);
  assert.notEqual(
    mismatched.status,
    0,
    "A mismatched OpenAPI must fail validation",
  );
  assert.match(mismatched.stderr, /Relay OpenAPI changed/);

  console.log(JSON.stringify({
    ok: true,
    missing_contract_failed: true,
    unreadable_contract_failed: true,
    mismatched_contract_failed: true,
  }));
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
