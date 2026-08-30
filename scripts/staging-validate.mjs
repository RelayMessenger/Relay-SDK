import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const release = resolve(root, ".release-tmp", "staging");
const pack = resolve(release, "pack");
const consumer = resolve(release, "consumer");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

const baseURL = process.env.RELAY_BASE_URL?.trim();
const agentToken = process.env.RELAY_AGENT_TOKEN?.trim();
if (!baseURL) {
  throw new Error("RELAY_BASE_URL is required.");
}
if (!agentToken) {
  throw new Error("RELAY_AGENT_TOKEN is required.");
}

const target = new URL(baseURL);
if (!["http:", "https:"].includes(target.protocol)) {
  throw new Error("RELAY_BASE_URL must be an absolute HTTP(S) URL.");
}
if (target.hostname === "api.relayapp.im") {
  throw new Error(
    "staging:validate refuses the production API host; inject staging or local.",
  );
}

rmSync(release, { recursive: true, force: true });
mkdirSync(pack, { recursive: true });
mkdirSync(consumer, { recursive: true });

execFileSync(npm, [
  "run",
  "build",
  "--workspace",
  "@relaymessenger/sdk",
], { cwd: root, stdio: "inherit" });

execFileSync(npm, [
  "pack",
  "--workspace",
  "@relaymessenger/sdk",
  "--ignore-scripts",
  "--pack-destination",
  pack,
], { cwd: root, stdio: "inherit" });

const tarballs = readdirSync(pack).filter((name) => name.endsWith(".tgz"));
assert.equal(tarballs.length, 1, "Expected exactly one packed SDK tarball.");
const tarball = resolve(pack, tarballs[0]);
const tarballSHA256 = createHash("sha256")
  .update(readFileSync(tarball))
  .digest("hex");

writeFileSync(resolve(consumer, "package.json"), JSON.stringify({
  private: true,
  type: "module",
}));
execFileSync(npm, [
  "install",
  "--ignore-scripts",
  "--no-audit",
  "--no-fund",
  tarball,
], { cwd: consumer, stdio: "inherit" });

const runner = resolve(consumer, "validate.mjs");
writeFileSync(runner, `
  import assert from "node:assert/strict";
  import Relay, { RELAY_V1_OPERATIONS } from "@relaymessenger/sdk";

  const baseURL = process.env.RELAY_BASE_URL;
  const client = new Relay({
    apiKey: process.env.RELAY_AGENT_TOKEN,
    baseURL,
    maxRetries: 0,
  });
  let expectedBaseURL = baseURL;
  while (expectedBaseURL.endsWith("/")) {
    expectedBaseURL = expectedBaseURL.slice(0, -1);
  }
  assert.equal(client.baseURL, expectedBaseURL);
  assert.equal(RELAY_V1_OPERATIONS.length, 34);
  assert.equal(
    RELAY_V1_OPERATIONS.some((operation) => operation.path === "/v1/websocket"),
    false,
  );
  assert.equal(typeof client.websocket.run, "function");
  assert.equal("retrieve" in client.websocket, false);
  assert.equal("update" in client.websocket, false);

  const page = await client.chats.listChats(
    { limit: 1 },
    { timeout: 10_000, maxRetries: 0 },
  );
  assert.ok(Array.isArray(page.chats));
  process.stdout.write(JSON.stringify({
    ok: true,
    base_url: client.baseURL,
    chats_returned: page.chats.length,
    operations: RELAY_V1_OPERATIONS.length,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  }));
`);

const remoteResult = JSON.parse(execFileSync(process.execPath, [runner], {
  cwd: consumer,
  encoding: "utf8",
  env: {
    ...process.env,
    RELAY_BASE_URL: target.toString().replace(/\/$/, ""),
    RELAY_AGENT_TOKEN: agentToken,
  },
}));

rmSync(consumer, { recursive: true, force: true });
console.log(JSON.stringify({
  ...remoteResult,
  package: "@relaymessenger/sdk@0.1.0",
  tarball: tarballs[0],
  tarball_sha256: tarballSHA256,
  published: false,
}));
