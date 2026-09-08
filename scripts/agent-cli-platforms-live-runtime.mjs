// Live staging native process proof using the already-created, explicitly assigned phone fixture. ZERO bootstrap calls.
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
const liveFile = process.env.RELAY_LIVE_AGENT_FILE;
const stopFile = process.env.RELAY_LIVE_STOP_FILE;
if (!liveFile || !stopFile) throw Error("Explicit private fixture and owned stop-marker paths are required");
let live; try { live = JSON.parse(readFileSync(liveFile, "utf8")); } catch { throw Error("Private fixture could not be parsed; contents suppressed"); }
if (live.origin !== "https://api.staging.relayapp.im" || live.server_commit !== "9f0a023c65dc52515d2916d1d8f90118fd0bf790" || !/^rly_live_[A-Za-z0-9]{43}$/.test(live.secret) || live.agent?.handle !== "clear_lusowl1.dev") throw Error("Assigned private fixture validation failed; contents suppressed");
const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = join(workspace, "packages/openclaw");
const receiptPath = resolve(process.env.RELAY_RUNTIME_PROOF_RECEIPT ?? join(workspace, ".release-tmp", "agent-cli-runtime-proof.json"));
mkdirSync(dirname(receiptPath), { recursive: true });
const redact = value => String(value).replace(/rly_live_[A-Za-z0-9]{43}/g, "[REDACTED_FIXTURE_TOKEN]");
const receipt = { platform: process.platform, arch: process.arch, node: process.version, sandbox: process.env.RELAY_DAYTONA_SANDBOX_ID, coverage: "LIVE staging Agent Token -> installed canonical auth login -> actual OpenClaw; local deterministic model; phone evidence required", serverCommit: live.server_commit, handle: live.agent.handle, shareUrl: live.share_url, liveBootstrapCalls: 0, commands: [] };
function execFileSync(command, args, options = {}) {
  const row = { command: [command, ...args], cwd: options.cwd }; receipt.commands.push(row);
  try { const output = nativeExecFileSync(command, args, options); row.output = redact(output); row.exit = 0; return output; }
  catch (error) { row.output = redact(`${error.stdout ?? ""}${error.stderr ?? ""}`); row.exit = error.status; throw error; }
  finally { writeFileSync(receiptPath, JSON.stringify(receipt, null, 2)); }
}
receipt.sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspace, encoding: "utf8" }).trim();
receipt.dirty = execFileSync("git", ["status", "--porcelain"], { cwd: workspace, encoding: "utf8" }).trim();
const temp = mkdtempSync(join(tmpdir(), "relay-live-phone-runtime-"));
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
    OPENCLAW_NO_AUTO_UPDATE: "1",
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
              work: { enabled: true, allowFrom: [live.phone_contact_id] },
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
  mock = spawn(process.execPath, [join(workspace, "scripts/agent-cli-platforms-model-server.mjs")], {
    cwd: temp,
    env: { ...env, MOCK_RELAY_PORT: String(relayPort), RELAY_FIXTURE_REQUEST: live.requested_message, RELAY_FIXTURE_REPLY: live.expected_reply },
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
  assert.equal(gateway, undefined, "selected isolated runtime must really be stopped before handoff");
  const loginArgs = ["--profile", "phone-roundtrip", "auth", "login", "--with-token", "--api-url", live.origin, "--connect", "openclaw", "--runtime-config", configPath, "--runtime-state-dir", stateDir, "--runtime-account", "work", "--confirm-configure", "--runtime-stopped"];
  const loggedIn = JSON.parse(execFileSync(join(consumer, "node_modules/.bin/relaymessenger"), loginArgs, { cwd: consumer, encoding: "utf8", input: live.secret + "\n", env: { ...env, RELAY_CONFIG_PATH: cliConfig } }));
  assert.equal(loggedIn.token, "stored"); assert.equal(loggedIn.handoff.status, "configured"); assert.equal(loggedIn.handoff.connected, false);
  assert.equal(loggedIn.handoff.handle, live.agent.handle);
  const configured = JSON.parse(readFileSync(configPath, "utf8"));
  const expectedConfig = structuredClone(originalConfig);
  expectedConfig.channels.relay.accounts.work.token = live.secret;
  expectedConfig.channels.relay.accounts.work.baseUrl = live.origin;
  assert.deepEqual(configured, expectedConfig, "handoff must preserve all unrelated runtime settings/accounts");
  receipt.handoff = { profile: loggedIn.profile, handle: live.agent.handle, status: loggedIn.handoff.status, connectedBeforeLaunch: false, preservedOtherSettings: true };
  receipt.privatePaths = { cliConfig, runtimeConfig: configPath, consumer, home, temp, originalAgentFile: liveFile };
  console.log("Existing assigned Agent Token configured in selected stopped native context; zero bootstrap calls");

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
  gateway.stdout.on("data", (chunk) => {
    gatewayOutput += chunk.toString();
  });
  gateway.stderr.on("data", (chunk) => {
    gatewayOutput += chunk.toString();
  });

  receipt.runtimePid = gateway.pid;
  receipt.modelPid = mock.pid;
  const startupDeadline = Date.now() + 45000;
  while (!gatewayOutput.includes("[gateway] ready")) {
    if (gateway.exitCode !== null || Date.now() > startupDeadline) throw Error(`Owned native runtime failed startup\n${gatewayOutput}`);
    await new Promise(done => setTimeout(done, 100));
  }
  receipt.result = "running-awaiting-phone";
  receipt.readyForPhoneActions = true;
  receipt.connectionProof = "pending actual phone request/reply; gateway ready log alone is not WebSocket proof";
  receipt.requestedMessage = live.requested_message;
  receipt.expectedReply = live.expected_reply;
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
  console.log("NATIVE_PHONE_READY: configured and actual process running; await matching phone request/reply");
  const deadline = Date.now() + 60 * 60 * 1000;
  let last = "";
  while (!existsSync(stopFile)) {
    if (gateway.exitCode !== null || mock.exitCode !== null) throw Error(`Owned live process exited unexpectedly\n${gatewayOutput}\n${mockOutput}`);
    if (Date.now() > deadline) throw Error("Phone coordination timeout; agent and private recovery state retained, no deletion attempted");
    const current = mockOutput.includes("matched phone request count=");
    if (String(current) !== last) {
      last = String(current); receipt.modelSawExactPhoneRequest = current;
      receipt.modelOutput = redact(mockOutput); receipt.gatewayOutput = redact(gatewayOutput);
      writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
    }
    await new Promise(done => setTimeout(done, 500));
  }
  const signal = JSON.parse(readFileSync(stopFile, "utf8"));
  assert.equal(signal.handle, live.agent.handle); assert.equal(signal.phoneProofComplete, true);
  assert.ok(mockOutput.includes("matched phone request count="), "No actual matching phone request reached the native model path");
  receipt.result = "phone-proof-complete-awaiting-owned-cleanup";
  receipt.phoneProof = signal;
  receipt.modelOutput = redact(mockOutput); receipt.gatewayOutput = redact(gatewayOutput);
} catch (error) {
  receipt.result = "failed"; receipt.failure = redact(error.stack ?? error); process.exitCode = 1;
  console.error(receipt.failure);
} finally {
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
  await Promise.all([stop(gateway), stop(mock)]);
  // Preserve private native/CLI context until main confirms owned deletion/cleanup. Never delete the live agent here.
  console.log("Owned processes stopped; agent/private state retained for explicit cleanup");
}
