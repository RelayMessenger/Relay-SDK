import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const files = [
  "scripts/validate-contract-copies.mjs",
  "contracts/relay-v1-operations.json",
  "contracts/relay-v1-openapi.yaml",
  "packages/chat-sdk-adapter/contracts/relay-openapi.yaml",
  "packages/openclaw/contracts/relay-openapi.yaml",
  "cookbook/cloudflare-think-agent/contracts/relay-openapi.yaml",
  "skills/relay/references/relay-v1-lock.json",
  "plugins/relay/skills/relay/references/relay-v1-lock.json",
  "packages/sdk/package.json",
  "packages/openclaw/contracts/relay-v1.lock.json",
  "packages/claude-code/contracts/relay-v1.lock.json",
  "packages/claude-code/plugin/contracts/relay-v1.lock.json",
];
const run = (directory) => spawnSync(process.execPath, [
  join(directory, "scripts/validate-contract-copies.mjs"),
], { encoding: "utf8" });

test("candidate copies validate without rewriting historical published skill pins", () => {
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
});

for (const [name, path, mutate] of [
  ["fixture drift", files[3], (text) => `${text}\n# drift\n`],
  ["workspace digest drift", files[1], (text) => {
    const value = JSON.parse(text);
    value.source_openapi_sha256 = "0".repeat(64);
    return JSON.stringify(value);
  }],
]) {
  test(`rejects ${name}`, (t) => {
    const temporary = mkdtempSync(join(tmpdir(), "relay-contract-copies-"));
    t.after(() => rmSync(temporary, { recursive: true, force: true }));
    for (const file of files) {
      mkdirSync(dirname(join(temporary, file)), { recursive: true });
      cpSync(join(root, file), join(temporary, file));
    }
    writeFileSync(join(temporary, path), mutate(readFileSync(join(temporary, path), "utf8")));
    const result = run(temporary);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /AssertionError/);
  });
}
