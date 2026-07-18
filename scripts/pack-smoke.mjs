import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const temp = mkdtempSync(join(tmpdir(), "relayapp-pack-smoke-"));
const packDir = join(temp, "pack");
const installDir = join(temp, "installed");

function npm(args, cwd = repoRoot) {
  const command = process.platform === "win32" ? "npm.cmd" : "npm";
  return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

try {
  mkdirSync(packDir, { recursive: true });
  mkdirSync(installDir, { recursive: true });
  // prepack always deletes dist before rebuilding, so this proves the package
  // does not depend on a locally stale ignored artifact.
  npm(["pack", "--workspace", "relayapp", "--pack-destination", packDir]);
  const tarballs = readdirSync(packDir).filter((name) => name.endsWith(".tgz"));
  assert.equal(tarballs.length, 1, "expected exactly one relayapp tarball");
  const tarball = join(packDir, tarballs[0]);

  writeFileSync(
    join(temp, "package.json"),
    `${JSON.stringify({ name: "relayapp-installed-smoke", private: true }, null, 2)}\n`,
  );
  npm(["install", "--no-audit", "--no-fund", tarball], temp);

  const installed = join(temp, "node_modules", "relayapp");
  for (const required of [
    "LICENSE",
    "README.md",
    "dist/cli.js",
    "dist/engine/acp.js",
    "dist/engine/process.js",
    "claude-plugin/marketplace/.claude-plugin/marketplace.json",
    "claude-plugin/marketplace/plugins/relay/.claude-plugin/plugin.json",
    "claude-plugin/marketplace/plugins/relay/commands/configure.md",
    "claude-plugin/marketplace/plugins/relay/runtime/server.mjs",
    "claude-plugin/marketplace/plugins/relay/LICENSE",
    "claude-plugin/marketplace/plugins/relay/README.md",
  ]) {
    assert.equal(existsSync(join(installed, required)), true, `missing packed file: ${required}`);
  }
  assert.equal(existsSync(join(installed, "src")), false, "source/tests must not leak into package");
  const openclawArchives = readdirSync(join(installed, "openclaw-plugin")).filter((name) => name.endsWith(".tgz"));
  assert.equal(openclawArchives.length, 1, "expected one bundled OpenClaw plugin archive");
  assert.equal(
    existsSync(join(temp, "node_modules", ".bin", process.platform === "win32" ? "relayapp.cmd" : "relayapp")),
    true,
    "npm did not install the relayapp executable",
  );

  const pkg = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
  assert.equal(pkg.bin.relayapp, "dist/cli.js");
  assert.equal(pkg.engines.node, ">=22.18");
  assert.equal(pkg.license, "MIT");
  assert.equal(pkg.dependencies["@agentclientprotocol/claude-agent-acp"], "0.59.0");
  assert.equal(pkg.dependencies["@agentclientprotocol/codex-acp"], "1.1.4");

  const help = execFileSync(process.execPath, [join(installed, "dist", "cli.js"), "--help"], {
    cwd: installDir,
    encoding: "utf8",
  });
  assert.match(help, /relayapp pair/);
  assert.match(help, /relayapp start/);
  assert.doesNotMatch(help, /staging/i);

  const smokeHome = join(temp, "home");
  const smokeRelayHome = join(smokeHome, ".relayapp");
  mkdirSync(smokeRelayHome, { recursive: true });
  writeFileSync(
    join(smokeRelayHome, "config.json"),
    `${JSON.stringify({
      api_origin: "https://api.relayapp.im",
      agent_token: "rly_pack_smoke_secret",
      owner_user_id: "usr_pack_owner",
      agent: { id: "agt_pack" },
    })}\n`,
  );
  chmodSync(join(smokeRelayHome, "config.json"), 0o600);

  const installClaude = execFileSync(
    process.execPath,
    [join(installed, "dist", "cli.js"), "install-claude"],
    {
      cwd: installDir,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: smokeHome,
        USERPROFILE: smokeHome,
        RELAYAPP_HOME: smokeRelayHome,
        PATH: `${join(repoRoot, "node_modules", ".bin")}:${process.env.PATH ?? ""}`,
      },
    },
  );
  assert.match(installClaude, /Installed bundled Claude plugin relay@relayapp-bundled/);
  assert.doesNotMatch(installClaude, /rly_pack_smoke_secret/);
  assert.match(
    readFileSync(join(smokeHome, ".claude", "channels", "relay", ".env"), "utf8"),
    /RELAY_AGENT_TOKEN=rly_pack_smoke_secret/,
  );
  const claudeEnv = {
    ...process.env,
    HOME: smokeHome,
    USERPROFILE: smokeHome,
    PATH: `${join(repoRoot, "node_modules", ".bin")}:${process.env.PATH ?? ""}`,
  };
  const claudePlugins = JSON.parse(execFileSync("claude", ["plugin", "list", "--json"], {
    cwd: installDir,
    encoding: "utf8",
    env: claudeEnv,
  }));
  const relayClaude = claudePlugins.find((plugin) => plugin.id === "relay@relayapp-bundled");
  assert.ok(relayClaude?.installPath, "bundled Claude plugin was not installed");
  assert.equal(existsSync(join(relayClaude.installPath, "commands", "configure.md")), true);
  assert.doesNotMatch(relayClaude.installPath, /integrations[/\\]claude-code/);
  rmSync(join(installed, "claude-plugin"), { recursive: true, force: true });
  execFileSync("claude", ["plugin", "validate", relayClaude.installPath, "--strict"], {
    cwd: installDir,
    stdio: "pipe",
    env: claudeEnv,
  });

  const openclawHome = join(temp, "openclaw-home");
  const installOpenClaw = execFileSync(
    process.execPath,
    [join(installed, "dist", "cli.js"), "install-openclaw"],
    {
      cwd: installDir,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: openclawHome,
        USERPROFILE: openclawHome,
        RELAYAPP_HOME: smokeRelayHome,
        PATH: `${join(repoRoot, "node_modules", ".bin")}:${process.env.PATH ?? ""}`,
      },
    },
  );
  assert.match(installOpenClaw, /Installed bundled Relay plugin into OpenClaw/);
  assert.doesNotMatch(installOpenClaw, /rly_pack_smoke_secret/);
  const openclawEnv = {
    ...process.env,
    HOME: openclawHome,
    USERPROFILE: openclawHome,
    PATH: `${join(repoRoot, "node_modules", ".bin")}:${process.env.PATH ?? ""}`,
  };
  const openclawPlugins = JSON.parse(execFileSync("openclaw", ["plugins", "list", "--json"], {
    cwd: installDir,
    encoding: "utf8",
    env: openclawEnv,
  }));
  assert.ok(openclawPlugins.plugins?.some((plugin) => plugin.id === "relay"), "OpenClaw did not load Relay");
  rmSync(join(installed, "openclaw-plugin"), { recursive: true, force: true });
  const openclawAfterSourceRemoval = JSON.parse(execFileSync("openclaw", ["plugins", "list", "--json"], {
    cwd: installDir,
    encoding: "utf8",
    env: openclawEnv,
  }));
  assert.ok(openclawAfterSourceRemoval.plugins?.some((plugin) => plugin.id === "relay"));

  for (const adapter of [
    "@agentclientprotocol/claude-agent-acp/dist/index.js",
    "@agentclientprotocol/codex-acp/dist/index.js",
  ]) {
    const resolved = execFileSync(
      process.execPath,
      ["-e", `process.stdout.write(require.resolve(${JSON.stringify(adapter)}))`],
      { cwd: installed, encoding: "utf8" },
    );
    assert.equal(existsSync(resolved), true, `installed adapter missing: ${adapter}`);
  }

  process.stdout.write(`relayapp installed-tarball smoke passed (${tarballs[0]})\n`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
