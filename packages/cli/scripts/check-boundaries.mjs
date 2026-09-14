import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = resolve(root, "src");
const sourceFiles = (await readdir(sourceRoot))
  .filter((name) => extname(name) === ".ts" && !name.endsWith(".test.ts"));
const source = (
  await Promise.all(
    sourceFiles.map((name) => readFile(resolve(sourceRoot, name), "utf8")),
  )
).join("\n");
const manifest = JSON.parse(
  await readFile(resolve(root, "package.json"), "utf8"),
);

for (const forbidden of [
  "/v1/events",
  "/v1/pairings",
  "/v1/agents/me",
  "conversation_id",
]) {
  assert.equal(
    source.includes(forbidden),
    false,
    `Removed/private assumption leaked into current source: ${forbidden}`,
  );
}

// The ACP bridge drives Cursor, Gemini CLI and OpenCode over the Agent Client
// Protocol (acp-bridge.ts, owner ruling 2026-09-11), so `@agentclientprotocol/`
// is now a required dependency and import, not a forbidden one.
assert.equal(
  Object.keys(manifest.dependencies ?? {}).includes("@agentclientprotocol/sdk"),
  true,
  "The ACP bridge needs @agentclientprotocol/sdk as a runtime dependency.",
);

assert.match(source, /@relaymessenger\/sdk/);
assert.doesNotMatch(source, /fetch\([^)]*api\.relayapp\.im/);
console.log("CLI source boundaries OK");
