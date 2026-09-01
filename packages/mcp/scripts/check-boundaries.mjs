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

for (const forbiddenImport of [
  "@modelcontextprotocol/client",
  "@modelcontextprotocol/inspector",
  "@modelcontextprotocol/sdk",
  "server/http",
  "server/sse",
  "express",
  "hono",
]) {
  assert.equal(
    source.includes(`from "${forbiddenImport}`),
    false,
    `Remote, client, or legacy runtime leaked into server source: ${forbiddenImport}`,
  );
}

for (const forbiddenRelaySurface of [
  "/v1/events",
  "/v1/pairings",
  "/v1/agents/me",
  "conversation_id",
]) {
  assert.equal(
    source.includes(forbiddenRelaySurface),
    false,
    `Removed/private Relay assumption leaked into MCP source: ${forbiddenRelaySurface}`,
  );
}

assert.deepEqual(
  Object.keys(manifest.dependencies).sort(),
  ["@modelcontextprotocol/server", "@relaymessenger/sdk", "zod"],
);
assert.match(source, /@modelcontextprotocol\/server\/stdio/);
assert.match(source, /@relaymessenger\/sdk/);
assert.doesNotMatch(source, /fetch\([^)]*api\.relayapp\.im/);
console.log("MCP stdio/auth/source boundaries OK");
