// Derived from packages/openclaw/scripts/gateway-harness.mjs; actual process + newly bootstrapped credential proof.
import { execFileSync as nativeExecFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

if (process.platform !== "linux" || !process.env.RELAY_DAYTONA_SANDBOX_ID) throw Error("Run this Linux process proof inside owned Daytona only");
const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = join(workspace, "packages/openclaw");
const receiptPath = resolve(process.env.RELAY_RUNTIME_PROOF_RECEIPT ?? join(workspace, ".release-tmp", "agent-cli-runtime-proof.json"));
mkdirSync(dirname(receiptPath), { recursive: true });
const redact = value => String(value).replace(/rly_live_[A-Za-z0-9]{43}/g, "[REDACTED_FIXTURE_TOKEN]");
const receipt = { platform: process.platform, arch: process.arch, node: process.version, sandbox: process.env.RELAY_DAYTONA_SANDBOX_ID, coverage: "new installed CLI identity -> native config -> actual OpenClaw process against loopback Relay/model fixtures; NOT live staging", commands: [] };
function execFileSync(command, args, options = {}) {
  const row = { command: [command, ...args], cwd: options.cwd }; receipt.commands.push(row);
  try { const output = nativeExecFileSync(command, args, options); row.output = redact(output); row.exit = 0; return output; }
  catch (error) { row.output = redact(`${error.stdout ?? ""}${error.stderr ?? ""}`); row.exit = error.status; throw error; }
  finally { writeFileSync(receiptPath, JSON.stringify(receipt, null, 2)); }
}
receipt.sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspace, encoding: "utf8" }).trim();
receipt.dirty = execFileSync("git", ["status", "--porcelain"], { cwd: workspace, encoding: "utf8" }).trim();
const temp = mkdtempSync(join(tmpdir(), "relay-new-agent-runtime-"));
const home = join(temp, "home");
const pack = join(temp, "pack");
const require = createRequire(import.meta.url);
let openClawRoot = dirname(require.resolve("openclaw"));
while (openClawRoot !== dirname(openClawRoot)) {
  const candidate = join(openClawRoot, "package.json");
  if (existsSync(candidate)) {
    const value = JSON.parse(readFileSync(candidate, "utf8"));
    if (value.name === "openclaw") {
      const bin = typeof value.bin === "string"
        ? value.bin
        : value.bin?.openclaw;
      if (!bin) throw new Error("OpenClaw package has no CLI entry");
      openClawRoot = join(openClawRoot, bin);
      break;
    }
  }
  openClawRoot = dirname(openClawRoot);
}
const openclaw = openClawRoot;
if (openclaw === dirname(openclaw) || !existsSync(openclaw)) {
  throw new Error("could not locate the OpenClaw CLI entry");
}
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

async function freePort() {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolvePort(address.port));
    });
  });
}

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exit = new Promise((resolveExit) => child.once("exit", resolveExit));
  child.kill("SIGTERM");
  await Promise.race([
    exit,
    new Promise((resolveWait) => setTimeout(resolveWait, 2_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await new Promise((resolveExit) => child.once("exit", resolveExit));
  }
}

let mock;
let gateway;
try {
  mkdirSync(home, { recursive: true });
  mkdirSync(pack, { recursive: true });
  execFileSync(npm, ["pack", ".", "--pack-destination", pack], {
    cwd: root,
    stdio: "pipe",
    env: {
      ...process.env,
      NODE_OPTIONS: process.env.NODE_OPTIONS ?? "--max-old-space-size=768",
    },
  });
  const archives = readdirSync(pack).filter((name) => name.endsWith(".tgz"));
  if (archives.length !== 1) {
    throw new Error(`expected one plugin archive, found ${archives.length}`);
  }

  const stateDir = join(home, ".openclaw");
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    OPENCLAW_STATE_DIR: stateDir,
    NO_COLOR: "1",
    NODE_OPTIONS: process.env.NODE_OPTIONS ?? "--max-old-space-size=768",
  };
  execFileSync(
    process.execPath,
    [
      openclaw,
      "plugins",
      "install",
      `npm-pack:${join(pack, archives[0])}`,
      "--force",
      "--accept-capabilities",
    ],
    { cwd: temp, env, stdio: "pipe" },
  );
  const inspection = JSON.parse(
    execFileSync(process.execPath, [
      openclaw,
      "plugins",
      "inspect",
      "relay",
      "--json",
    ], {
      cwd: temp,
      env,
      encoding: "utf8",
    }),
  );
  if (
    inspection.install?.source !== "npm" ||
    inspection.install?.artifactKind !== "npm-pack" ||
    !inspection.install?.installPath
  ) {
    throw new Error(
      `OpenClaw did not inspect a managed npm-pack install: ${JSON.stringify(inspection.install)}`,
    );
  }
  if (!existsSync(join(inspection.install.installPath, "dist", "index.js"))) {
    throw new Error("OpenClaw inspected install is missing dist/index.js");
  }

  const relayPort = await freePort();
  const gatewayPort = await freePort();
  const cliPack = join(temp, "cli-pack"); const consumer = join(temp, "consumer");
  mkdirSync(cliPack); mkdirSync(consumer);
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
  const cliManifest = JSON.parse(readFileSync(join(workspace, "packages/cli/package.json"), "utf8"));
  assert.equal(cliManifest.name, "relaymessenger", "Use the canonical package, not a scoped compatibility wrapper");
  const archivesForCLI = [];
  for (const name of ["@relaymessenger/sdk", "relaymessenger"]) {
    const packed = JSON.parse(execFileSync(npm, ["pack", "--workspace", name, "--ignore-scripts", "--json", "--pack-destination", cliPack], { cwd: workspace, encoding: "utf8" }));
    archivesForCLI.push(join(cliPack, packed[0].filename));
  }
  receipt.tarballs = archivesForCLI.map(file => ({ name: file.split("/").at(-1), sha256: createHash("sha256").update(readFileSync(file)).digest("hex") }));
  execFileSync(npm, ["install", "--ignore-scripts", "--no-audit", "--no-fund", ...archivesForCLI], { cwd: consumer, stdio: "pipe" });
  assert.equal(existsSync(join(consumer, "node_modules/@relaymessenger/cli")), false, "No retired scoped wrapper may be installed");
  const cliBin = resolve(consumer, "node_modules/relaymessenger", cliManifest.bin.relaymessenger);
  const cliConfig = join(temp, "cli-config.json");
  for (const key of Object.keys(env)) if (key.startsWith("RELAY_")) delete env[key];

  const configPath = join(stateDir, "openclaw.json");
  const installedConfig = existsSync(configPath)
    ? JSON.parse(readFileSync(configPath, "utf8"))
    : {};
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        ...installedConfig,
        gateway: {
          mode: "local",
          bind: "loopback",
          auth: { mode: "none" },
        },
        plugins: {
          ...(installedConfig.plugins ?? {}),
          allow: ["relay"],
          entries: {
            ...(installedConfig.plugins?.entries ?? {}),
            relay: { enabled: true },
          },
        },
        channels: {
          relay: {
            enabled: true,
            // dispatch.ts uses the fixture Contact ID as the stable allowlist identity.
            defaultAccount: "work",
            accounts: {
              work: { enabled: true, allowFrom: ["00000000-0000-7000-8000-000000000013"] },
              other: { enabled: false, token: "synthetic-unrelated-account", allowFrom: ["other-fixture"] },
            },
          },
        },
        models: {
          mode: "replace",
          providers: {
            harness: {
              baseUrl: `http://127.0.0.1:${relayPort}/v1`,
              apiKey: "harness-key",
              api: "openai-completions",
              models: [
                {
                  id: "mock",
                  name: "Harness Mock",
                  reasoning: false,
                  input: ["text"],
                  cost: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                  },
                  contextWindow: 32768,
                  maxTokens: 4096,
                },
              ],
            },
          },
        },
        agents: {
          defaults: {
            model: { primary: "harness/mock" },
            workspace: join(temp, "workspace"),
            skipBootstrap: true,
          },
        },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );

  let mockOutput = "";
  let gatewayOutput = "";
  mock = spawn(process.execPath, [join(workspace, "scripts/agent-cli-platforms-runtime-server.mjs")], {
    cwd: temp,
    env: { ...env, MOCK_RELAY_PORT: String(relayPort), RELAY_TMUX_PROOF: process.env.RELAY_TMUX_PROOF ?? "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  mock.stdout.on("data", (chunk) => {
    mockOutput += chunk.toString();
  });
  mock.stderr.on("data", (chunk) => {
    mockOutput += chunk.toString();
  });
  const mockDeadline = Date.now() + 10_000;
  while (!mockOutput.includes("listening on")) {
    if (mock.exitCode !== null) {
      throw new Error(`mock Relay exited early\n${mockOutput}`);
    }
    if (Date.now() > mockDeadline) {
      throw new Error(`mock Relay did not listen\n${mockOutput}`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }

  const originalConfig = JSON.parse(readFileSync(configPath, "utf8"));
  assert.equal(gateway, undefined, "the isolated runtime must really be stopped before Relay writes its configuration");
  const createArgs = [cliBin, "agents", "create", "--api-url", `http://127.0.0.1:${relayPort}`, "--token-name", `verification-runtime-${process.pid}`, "--connect", "openclaw", "--runtime-config", configPath, "--runtime-state-dir", stateDir, "--runtime-account", "work", "--confirm-configure", "--runtime-stopped", "--json"];
  const created = JSON.parse(execFileSync(process.execPath, createArgs, { cwd: consumer, encoding: "utf8", env: { ...env, RELAY_CONFIG_PATH: cliConfig, RELAY_AGENT_TOKEN: "synthetic-wrong-environment-token" } }));
  assert.equal(created.token, "stored"); assert.equal(created.connect.status, "configured"); assert.equal(created.connect.connected, false);
  const privateProfile = JSON.parse(readFileSync(cliConfig, "utf8")).profiles[created.profile];
  const configured = JSON.parse(readFileSync(configPath, "utf8"));
  assert.match(privateProfile.agent_token, /^rly_live_[A-Za-z0-9]{43}$/);
  assert.equal(configured.channels.relay.accounts.work.token, privateProfile.agent_token);
  const expectedConfig = structuredClone(originalConfig);
  expectedConfig.channels.relay.accounts.work.token = privateProfile.agent_token;
  expectedConfig.channels.relay.accounts.work.baseUrl = `http://127.0.0.1:${relayPort}`;
  assert.deepEqual(configured, expectedConfig, "connecting must preserve every unrelated runtime setting and account");
  receipt.connect = { profile: created.profile, handle: created.agent.handle, status: created.connect.status, connectedBeforeLaunch: created.connect.connected, preservedOtherSettings: true };
  console.log("Installed CLI create handed its new credential to selected stopped native account; other settings preserved");

  gateway = spawn(process.execPath, [
    openclaw,
    "gateway",
    "run",
    "--port",
    String(gatewayPort),
  ], {
    cwd: temp,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  receipt.runtimePid = gateway.pid; receipt.modelPid = mock.pid; receipt.controlOrigin = `http://127.0.0.1:${relayPort}`; receipt.temp = temp;
  gateway.stdout.on("data", (chunk) => {
    gatewayOutput += chunk.toString();
  });
  gateway.stderr.on("data", (chunk) => {
    gatewayOutput += chunk.toString();
  });

  const deadline = Date.now() + 60_000;
  while (
    !/cumulative ACK 1 durable=\w+ count=2/u.test(mockOutput) ||
    !mockOutput.includes("Message send count=1")
  ) {
    if (gateway.exitCode !== null) {
      throw new Error(
        `OpenClaw gateway exited before proof\n${gatewayOutput}\n${mockOutput}`,
      );
    }
    if (mock.exitCode !== null) {
      throw new Error(
        `mock Relay exited before proof\n${gatewayOutput}\n${mockOutput}`,
      );
    }
    if (Date.now() > deadline) {
      throw new Error(
        `OpenClaw gateway harness timed out\n${gatewayOutput}\n${mockOutput}`,
      );
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }

  for (const proof of [
    "Bootstrap create count=1",
    "Created credential Contact Card validated",
    "GET /v1/webhook-subscriptions",
    "UPGRADE /v1/websocket",
    "JSON heartbeat pong",
    "cumulative ACK 1 durable=",
    "completion request count=1",
    `POST /v1/chats/00000000-0000-7000-8000-000000000010/messages`,
    "Message send count=1",
  ]) {
    if (!mockOutput.includes(proof)) {
      throw new Error(`missing gateway proof "${proof}"\n${mockOutput}`);
    }
  }
  if (
    mockOutput.includes("Bootstrap create count=2") ||
    mockOutput.includes("completion request count=2") ||
    mockOutput.includes("Message send count=2")
  ) {
    throw new Error(`replayed event repeated work\n${mockOutput}`);
  }
  for (const removed of ["/v1/events", "/v1/conversations", "/v1/agents/me"]) {
    if (mockOutput.includes(removed)) {
      throw new Error(`gateway used removed Relay path ${removed}\n${mockOutput}`);
    }
  }

  console.log(
    "New installed CLI identity -> native connect -> actual OpenClaw WebSocket gateway proof passed.",
  );
  console.log(
    "Proof: durable cumulative ACK, replay suppression, heartbeat, one model turn, one idempotent Chat Message.",
  );
  if (process.env.RELAY_RUNTIME_RELEASE_FILE) {
    receipt.result = "native-proof-passed-awaiting-tmux-control";
    const holdDeadline = Date.now() + 180000;
    while (!existsSync(process.env.RELAY_RUNTIME_RELEASE_FILE)) {
      if (Date.now() > holdDeadline || gateway.exitCode !== null || mock.exitCode !== null) throw Error("Owned tmux runtime hold failed or timed out");
      receipt.protocolOutput = redact(mockOutput); writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
      await new Promise(done => setTimeout(done, 250));
    }
    if (process.env.RELAY_TMUX_PROOF === "1") {
      assert.ok(mockOutput.includes("cumulative ACK 2 durable="));
      assert.ok(mockOutput.includes("completion request count=2"));
      assert.ok(mockOutput.includes("Message send count=2"));
      assert.ok(!mockOutput.includes("Message send count=3"));
      receipt.postReattach = "second deliberate event durably ACKed and replied exactly once in observed fixture";
    }
  }
  receipt.result = "passed";
  receipt.protocolOutput = redact(mockOutput);
  receipt.gatewayOutput = redact(gatewayOutput);
} catch (error) {
  receipt.result = "failed"; receipt.failure = redact(error.stack ?? error); process.exitCode = 1;
  console.error(receipt.failure);
} finally {
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
  await Promise.all([stop(gateway), stop(mock)]);
  rmSync(temp, { recursive: true, force: true, maxRetries: 10 });
}
