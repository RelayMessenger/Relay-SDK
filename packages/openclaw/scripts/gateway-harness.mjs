import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import {
  candidateTarball,
  candidateConsumerManifest,
  assertInstalledCandidate,
} from "../../sdk/scripts/candidate-tarball.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const candidate = candidateTarball({
  name: "@relaymessenger/sdk",
  version: packageJson.dependencies["@relaymessenger/sdk"],
  variable: "RELAY_SDK_CANDIDATE_TARBALL",
});
const temp = realpathSync(mkdtempSync(join(tmpdir(), "relay-openclaw-gateway-")));
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

function ownedPath(path, owner) {
  assert.ok(typeof path === "string" && isAbsolute(path), "expected an absolute managed path");
  const actual = realpathSync(path);
  const within = relative(realpathSync(owner), actual);
  assert.ok(
    within && within !== ".." && !within.startsWith(`..${sep}`) && !isAbsolute(within),
    `managed path escapes the harness-owned directory: ${path}`,
  );
  return actual;
}

function managedCandidateProject(install, stateDir) {
  assert.equal(install?.source, "npm", "candidate requires a managed npm install");
  assert.equal(install?.artifactKind, "npm-pack", "candidate requires the packed plugin");
  // Resolve the installer receipt, never guess an extensions/ or npm/projects/ path.
  const owner = ownedPath(stateDir, temp);
  const installed = ownedPath(install.installPath, owner);
  const installedManifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
  assert.equal(installedManifest.name, packageJson.name);
  assert.equal(installedManifest.version, packageJson.version);
  for (let project = dirname(installed); project !== owner; project = dirname(project)) {
    ownedPath(project, owner);
    const manifestPath = join(project, "package.json");
    const lockPath = join(project, "package-lock.json");
    if (!existsSync(manifestPath) || !existsSync(lockPath)) continue;
    for (const path of [manifestPath, lockPath]) {
      ownedPath(path, project);
      assert.ok(lstatSync(path).isFile(), "managed manifest and lock must be regular files");
    }
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    const key = relative(project, installed).split(sep).join("/");
    assert.equal(key, `node_modules/${packageJson.name}`, "plugin must belong to the managed project");
    assert.ok(manifest.dependencies?.[packageJson.name], "managed project must depend on the plugin");
    assert.equal(lock.packages?.[key]?.version, packageJson.version, "managed lock must contain the plugin");
    return { project, installed, manifestPath, manifest };
  }
  throw new Error("could not locate the managed plugin's package.json + package-lock.json project");
}

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
  if (candidate) {
    // Inspect returns the effective install record; recent OpenClaw versions do
    // not persist plugins.installs in openclaw.json. Keep its npm/archive proof.
    const { project, installed, manifestPath, manifest } =
      managedCandidateProject(inspection.install, stateDir);
    const pluginManifest = readFileSync(join(installed, "package.json"), "utf8");
    // Change only the disposable project, not the packed/installed plugin manifest.
    writeFileSync(
      manifestPath,
      `${JSON.stringify(candidateConsumerManifest(manifest, [candidate]), null, 2)}\n`,
    );
    execFileSync(npm, [
      "install",
      "--prefix", project,
      "--ignore-scripts",
      "--omit=optional",
      "--legacy-peer-deps",
      "--package-lock=true",
      "--no-audit",
      "--no-fund",
    ], { cwd: project, env, stdio: "inherit" });
    assert.equal(readFileSync(join(installed, "package.json"), "utf8"), pluginManifest);
    const importer = join(installed, "dist", "index.js");
    ownedPath(createRequire(importer).resolve("@relaymessenger/sdk/package.json"), project);
    assertInstalledCandidate(project, importer, candidate);
    console.log(JSON.stringify({
      validationMode: "local-candidate-not-registry",
      proof: "managed plugin resolves retained SDK archive",
      installPath: installed,
      project,
      integrity: candidate.integrity,
    }));
  }

  const relayPort = await freePort();
  const gatewayPort = await freePort();
  const tokenFile = join(stateDir, "secrets", "relay-agent-token");
  mkdirSync(dirname(tokenFile), { recursive: true });
  writeFileSync(tokenFile, "rly_harness_token\n", { mode: 0o600 });

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
            tokenFile,
            baseUrl: `http://127.0.0.1:${relayPort}`,
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
  mock = spawn(process.execPath, [join(root, "harness", "mock-relay-server.mjs")], {
    cwd: temp,
    env: { ...env, MOCK_RELAY_PORT: String(relayPort) },
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
    `Relay OpenClaw installed npm-pack inspect + WebSocket gateway harness passed (${candidate ? "local candidate; NOT registry/release validation" : "registry dependencies"}).`,
  );
  console.log(
    "Proof: durable cumulative ACK, replay suppression, heartbeat, one model turn, one idempotent Chat Message.",
  );
} finally {
  await Promise.all([stop(gateway), stop(mock)]);
  rmSync(temp, { recursive: true, force: true, maxRetries: 10 });
}
