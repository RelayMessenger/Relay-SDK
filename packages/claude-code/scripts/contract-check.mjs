import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const readJSON = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));
const packageJSON = readJSON("package.json");
const plugin = readJSON(".claude-plugin/plugin.json");
const marketplace = readJSON(".claude-plugin/marketplace.json");
const lock = readJSON("contracts/relay-v1.lock.json");
const source = readJSON("SOURCE.json");
const sourceLock = JSON.parse(
  readFileSync(join(root, "../..", "sources.lock.json"), "utf8"),
);
const sdkPackagePath = require.resolve("@relaymessenger/sdk/package.json");
const sdkTypes = readFileSync(
  join(dirname(sdkPackagePath), "dist", "types.d.ts"),
  "utf8",
);
const workspaceOpenapi = readFileSync(
  join(root, "..", "..", "contracts", "relay-v1-openapi.yaml"),
);
const workspaceOpenapiSha256 = createHash("sha256")
  .update(workspaceOpenapi)
  .digest("hex");
const repository = "https://github.com/RelayMessenger/Relay-SDK";
const homepage =
  `${repository}/tree/main/packages/claude-code#readme`;

function sourceFiles(directory) {
  const output = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) output.push(...sourceFiles(path));
    else if (/\.(?:ts|mjs)$/u.test(name)) output.push(path);
  }
  return output;
}

if (packageJSON.name !== "relay-claude-channel") throw new Error("npm package identity drifted");
if (packageJSON.packageManager !== "npm@12.0.2") throw new Error("npm toolchain lock drifted");
if (packageJSON.version !== plugin.version) throw new Error("package and plugin versions differ");
if (!/^\d+\.\d+\.\d+-staging\.\d+$/u.test(packageJSON.version)) {
  throw new Error("package version is not an explicit staging prerelease");
}
if (marketplace.plugins?.[0]?.version !== packageJSON.version) {
  throw new Error("marketplace release version differs");
}
if (JSON.stringify(packageJSON.publishConfig) !== JSON.stringify({
  access: "public",
  registry: "https://registry.npmjs.org/",
  tag: "staging",
  provenance: true,
})) {
  throw new Error("npm publication is not staging-only with provenance");
}
if (marketplace.plugins?.[0]?.name !== plugin.name) throw new Error("marketplace and plugin names differ");
if (marketplace.plugins?.[0]?.source !== "./plugin") {
  throw new Error("marketplace must install the dependency-free plugin artifact");
}
for (const [canonical, artifact] of [
  [".claude-plugin/plugin.json", "plugin/.claude-plugin/plugin.json"],
  [".mcp.json", "plugin/.mcp.json"],
  ["commands/configure.md", "plugin/commands/configure.md"],
  ["contracts/relay-v1.lock.json", "plugin/contracts/relay-v1.lock.json"],
  ["README.md", "plugin/README.md"],
  ["LICENSE", "plugin/LICENSE"],
  ["NOTICE", "plugin/NOTICE"],
  ["runtime/server.mjs", "plugin/runtime/server.mjs"],
]) {
  if (readFileSync(join(root, canonical), "utf8") !== readFileSync(join(root, artifact), "utf8")) {
    throw new Error(`plugin artifact drifted from ${canonical}`);
  }
}
if (JSON.stringify(packageJSON.repository) !== JSON.stringify({
  type: "git",
  url: "git+https://github.com/RelayMessenger/Relay-SDK.git",
  directory: "packages/claude-code",
})) {
  throw new Error("repository metadata is not Relay-SDK packages/claude-code");
}
if (JSON.stringify(packageJSON.bugs) !== JSON.stringify({
  url: `${repository}/issues`,
})) {
  throw new Error("bug tracker metadata is not Relay-SDK issues");
}
if (packageJSON.homepage !== homepage) {
  throw new Error("package homepage is not the Relay-SDK Claude package directory");
}
if (JSON.stringify(source) !== JSON.stringify({
  ...sourceLock.imports["packages/claude-code"],
  imported_at: "2026-09-01",
  canonical: "Relay-SDK",
})) {
  throw new Error("SOURCE.json does not match the canonical import receipt");
}
for (const metadata of [plugin, marketplace.plugins?.[0]]) {
  if (metadata?.repository !== repository || metadata?.homepage !== homepage) {
    throw new Error("Claude metadata is not the Relay-SDK Claude package directory");
  }
}
if (!readFileSync(join(root, "README.md"), "utf8").includes(
  "/absolute/path/to/Relay-SDK/packages/claude-code",
)) {
  throw new Error("local marketplace install does not target packages/claude-code");
}
if (packageJSON.dependencies?.[lock.relaySdk.package] !== lock.relaySdk.version) {
  throw new Error("Relay SDK dependency does not match the contract lock");
}
if (
  !/\bimage_url: string \| null;/u.test(sdkTypes)
  || !/\babout: string \| null;/u.test(sdkTypes)
  || /\bavatar_url\b/u.test(sdkTypes)
  || /\btagline\b/u.test(sdkTypes)
) {
  throw new Error("Relay SDK Contact declarations must expose image_url and about only");
}
if (lock.relayServer.commit !== "4506b8cb6f41da0b39f3e23a285daf3805fcf3a3") {
  throw new Error("Relay Server commit lock drifted");
}
if (lock.relayServer.sha256 !== "e58ffd5de05250a7a218735cb6bffd854d2d1198134f3f8876b2be109f606fde") {
  throw new Error("Relay OpenAPI hash lock drifted");
}
if (
  workspaceOpenapiSha256 !== lock.relaySdk.workspaceOpenapiSha256
  || workspaceOpenapiSha256 !== lock.relayServer.sha256
) {
  throw new Error("Relay workspace OpenAPI hash drifted");
}

const implementation = [join(root, "server.ts"), ...sourceFiles(join(root, "src"))]
  .map((path) => readFileSync(path, "utf8"))
  .join("\n");
for (const [label, pattern] of [
  ["removed Events polling API", /\/v1\/events|pollEvents|startPoller/iu],
  ["removed Conversation API", /conversation_id|\/v1\/conversations/iu],
  ["private Agent identity API", /\/v1\/agents|agents\/me/iu],
  ["installation API", /\/v1\/installations/iu],
  ["Message effects", /message_effect|effect_id/iu],
  ["hand-written HTTP transport", /\bfetch\s*\(/u],
]) {
  if (pattern.test(implementation)) throw new Error(`implementation contains ${label}`);
}
for (const required of [
  "relay.websocket.run",
  "onFullSync",
  "webhookSubscriptions.list",
  "chats.listChats",
  "chats.messages.list",
  "relay.messages.retrieve",
  "chats.markAsRead",
  "chats.messages.send",
]) {
  if (!implementation.includes(required)) throw new Error(`implementation is missing SDK path ${required}`);
}
for (const requiredGrammar of [
  '"claude/channel": {}',
  'notifications/claude/channel',
]) {
  if (!implementation.includes(requiredGrammar)) {
    throw new Error(`implementation is missing Claude channel grammar ${requiredGrammar}`);
  }
}
for (const forbiddenPermissionSurface of [
  '"claude/channel/permission"',
  "notifications/claude/channel/permission_request",
  "notifications/claude/channel/permission",
]) {
  if (implementation.includes(forbiddenPermissionSurface)) {
    throw new Error(
      `implementation must keep Claude permissions local: found ${forbiddenPermissionSurface}`,
    );
  }
}

const openapiFlag = process.argv.indexOf("--openapi");
const suppliedOpenAPI = openapiFlag >= 0 ? process.argv[openapiFlag + 1] : process.env.RELAY_OPENAPI_PATH;
if (openapiFlag >= 0 && !suppliedOpenAPI) throw new Error("--openapi requires a path");
let openapiReceipt = "not supplied (lock-only check)";
if (suppliedOpenAPI) {
  const path = resolve(suppliedOpenAPI);
  if (!existsSync(path)) throw new Error(`OpenAPI file not found: ${path}`);
  const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
  if (digest !== lock.relayServer.sha256) {
    throw new Error(`OpenAPI SHA-256 ${digest} does not match ${lock.relayServer.sha256}`);
  }
  openapiReceipt = `${path} sha256=${digest}`;
}

process.stdout.write([
  `Relay contract lock passed: Server ${lock.relayServer.commit}`,
  `OpenAPI ${openapiReceipt}`,
  `SDK ${lock.relaySdk.package}@${lock.relaySdk.version}`,
  `Claude Code docs retrieved ${lock.claudeCode.retrievedOn}; validation target ${lock.claudeCode.validatedCliVersion}`,
].join("\n") + "\n");
