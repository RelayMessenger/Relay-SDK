import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { Readable, Writable } from "node:stream";
import { resolve } from "node:path";
import { client, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";

const engine = process.argv[2];
const packageRoot = process.argv[3] ? resolve(process.argv[3]) : undefined;
assert.ok(["claude", "codex", "hermes"].includes(engine), "usage: acp-runtime-smoke.mjs <claude|codex|hermes> [installed-relayapp-root]");

function processSpec() {
  if (engine === "hermes") return { command: "hermes", args: ["acp"] };
  assert.ok(packageRoot, `${engine} smoke requires the installed relayapp package root`);
  const installedRequire = createRequire(resolve(packageRoot, "package.json"));
  const entrypoint = engine === "claude"
    ? installedRequire.resolve("@agentclientprotocol/claude-agent-acp/dist/index.js")
    : installedRequire.resolve("@agentclientprotocol/codex-acp");
  return { command: process.execPath, args: [entrypoint] };
}

const spec = processSpec();
const child = spawn(spec.command, spec.args, {
  stdio: ["pipe", "pipe", "pipe"],
  env: process.env,
  windowsHide: true,
});
let stderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});

const deadline = setTimeout(() => {
  child.kill("SIGKILL");
}, 30_000);

try {
  const stream = ndJsonStream(
    Writable.toWeb(child.stdin),
    Readable.toWeb(child.stdout),
  );
  const connection = client({ name: "relayapp-runtime-smoke" }).connect(stream);
  const response = await connection.agent.request("initialize", {
    protocolVersion: PROTOCOL_VERSION,
    clientInfo: { name: "relayapp-runtime-smoke", version: "0.2.0" },
    clientCapabilities: {},
  });
  assert.equal(
    response.protocolVersion,
    PROTOCOL_VERSION,
    `${engine} negotiated ${response.protocolVersion}, expected ${PROTOCOL_VERSION}`,
  );
  const capabilities = response.agentCapabilities ?? {};
  process.stdout.write(
    `${engine} ACP initialize passed: protocol=${response.protocolVersion} ` +
      `loadSession=${String(capabilities.loadSession === true)}\n`,
  );
  connection.close();
} catch (error) {
  throw new Error(`${engine} ACP initialize failed: ${String(error)}${stderr ? `\nstderr:\n${stderr}` : ""}`);
} finally {
  clearTimeout(deadline);
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolveExit) => child.once("exit", resolveExit)),
    new Promise((resolveWait) => setTimeout(resolveWait, 2_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}
