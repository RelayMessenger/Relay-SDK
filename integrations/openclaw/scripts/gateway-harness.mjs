import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageRoot, "../..");
const temp = mkdtempSync(join(tmpdir(), "relay-openclaw-gateway-"));
const home = join(temp, "home");
const packDir = join(temp, "pack");
const openclaw = join(
  repoRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "openclaw.cmd" : "openclaw",
);
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

async function freePort() {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolvePort(port));
    });
  });
}

async function stop(child) {
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  if (!child || exited()) return;
  const gracefulExit = new Promise((resolveExit) => child.once("exit", resolveExit));
  child.kill("SIGTERM");
  await Promise.race([
    gracefulExit,
    new Promise((resolveWait) => setTimeout(resolveWait, 2_000)),
  ]);
  if (!exited()) {
    const forcedExit = new Promise((resolveExit) => child.once("exit", resolveExit));
    child.kill("SIGKILL");
    await forcedExit;
  }
}

let mock;
let gateway;
try {
  mkdirSync(home, { recursive: true });
  mkdirSync(packDir, { recursive: true });
  execFileSync(npm, ["pack", ".", "--pack-destination", packDir], {
    cwd: packageRoot,
    stdio: "pipe",
  });
  const archives = readdirSync(packDir).filter((name) => name.endsWith(".tgz"));
  if (archives.length !== 1) throw new Error(`expected one plugin archive, found ${archives.length}`);
  const env = { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: "1" };
  execFileSync(openclaw, ["plugins", "install", `npm-pack:${join(packDir, archives[0])}`, "--force"], {
    cwd: temp,
    env,
    stdio: "pipe",
  });
  const inspection = JSON.parse(
    execFileSync(openclaw, ["plugins", "inspect", "relay", "--json"], {
      cwd: temp,
      env,
      encoding: "utf8",
    }),
  );
  if (inspection.install?.source !== "npm" || inspection.install?.artifactKind !== "npm-pack") {
    throw new Error(`OpenClaw did not record the managed npm-pack install: ${JSON.stringify(inspection.install)}`);
  }
  const installedRequire = createRequire(join(inspection.install.installPath, "package.json"));
  const fsSafeManifest = installedRequire("@openclaw/fs-safe/package.json");
  // Compare against what THIS package declares, never a literal. The check
  // exists to prove the packed tarball resolves its own pinned dependency,
  // and a hardcoded version turns every routine Dependabot bump into a red
  // Required CI even though nothing is actually broken.
  const declaredFsSafe = JSON.parse(
    readFileSync(join(packageRoot, "package.json"), "utf8"),
  ).dependencies?.["@openclaw/fs-safe"];
  if (!declaredFsSafe) {
    throw new Error("the plugin no longer declares @openclaw/fs-safe");
  }
  // The pin is exact today. If it is ever loosened to a range, the resolved
  // version is whatever npm picked and there is nothing to assert.
  const isExactPin = /^\d+\.\d+\.\d+/.test(declaredFsSafe);
  if (isExactPin && fsSafeManifest.version !== declaredFsSafe) {
    throw new Error(
      `installed plugin resolved @openclaw/fs-safe ${fsSafeManifest.version}, expected the declared ${declaredFsSafe}`,
    );
  }

  const relayPort = await freePort();
  const gatewayPort = await freePort();
  const openclawHome = join(home, ".openclaw");
  const tokenFile = join(openclawHome, "secrets", "relay-agent-token");
  mkdirSync(dirname(tokenFile), { recursive: true });
  writeFileSync(tokenFile, "rly_harness_token\n", { mode: 0o600 });
  const configPath = join(openclawHome, "openclaw.json");
  const installedConfig = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {};
  const config = {
    ...installedConfig,
    gateway: { mode: "local", bind: "loopback", auth: { mode: "none" } },
    plugins: {
      ...(installedConfig.plugins ?? {}),
      allow: ["relay"],
      entries: { ...(installedConfig.plugins?.entries ?? {}), relay: { enabled: true } },
    },
    channels: {
      relay: {
        enabled: true,
        tokenFile,
        baseUrl: `http://127.0.0.1:${relayPort}`,
        pollTimeoutSeconds: 1,
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
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
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
  };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });

  let mockOutput = "";
  let gatewayOutput = "";
  mock = spawn(process.execPath, [join(packageRoot, "harness", "mock-relay-server.mjs")], {
    cwd: temp,
    env: { ...env, MOCK_RELAY_PORT: String(relayPort), MOCK_LLM_REPLY: "short" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  mock.stdout.on("data", (chunk) => { mockOutput += chunk.toString(); });
  mock.stderr.on("data", (chunk) => { mockOutput += chunk.toString(); });

  const mockDeadline = Date.now() + 10_000;
  while (!mockOutput.includes("listening on")) {
    if (mock.exitCode !== null) throw new Error(`mock server exited early\n${mockOutput}`);
    if (Date.now() > mockDeadline) throw new Error(`mock server did not listen\n${mockOutput}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }

  gateway = spawn(openclaw, ["gateway", "run", "--port", String(gatewayPort)], {
    cwd: temp,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  gateway.stdout.on("data", (chunk) => { gatewayOutput += chunk.toString(); });
  gateway.stderr.on("data", (chunk) => { gatewayOutput += chunk.toString(); });

  const deadline = Date.now() + 45_000;
  while (!mockOutput.includes("POST /v2/conversations/cnv_harness_1/messages")) {
    if (gateway.exitCode !== null) {
      throw new Error(`OpenClaw gateway exited before the Relay reply\n${gatewayOutput}\n${mockOutput}`);
    }
    if (Date.now() > deadline) {
      throw new Error(`OpenClaw gateway harness timed out\n${gatewayOutput}\n${mockOutput}`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  for (const proof of [
    "GET /v1/agents/me",
    "GET /v1/events",
    "completion request",
    "POST /v2/conversations/cnv_harness_1/messages",
  ]) {
    if (!mockOutput.includes(proof)) throw new Error(`missing gateway proof: ${proof}\n${mockOutput}`);
  }
  const completionIndex = mockOutput.indexOf("completion request");
  const sendIndex = mockOutput.indexOf("POST /v2/conversations/cnv_harness_1/messages");
  if (completionIndex > sendIndex) {
    throw new Error(`the reply was sent before the engine ran\n${mockOutput}`);
  }
  process.stdout.write("OpenClaw installed-runtime gateway harness passed end to end.\n");
} finally {
  await Promise.all([stop(gateway), stop(mock)]);
  rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
