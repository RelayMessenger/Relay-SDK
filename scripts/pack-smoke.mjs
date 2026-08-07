import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
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
import { delimiter, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const temp = mkdtempSync(join(tmpdir(), "relaymessenger-pack-smoke-"));
const packDir = join(temp, "pack");
const installDir = join(temp, "installed");

function npm(args, cwd = repoRoot) {
  const command = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
    shell: process.platform === "win32",
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed:\n${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    );
  }
  return result.stdout ?? "";
}

function cli(name, args, options = {}) {
  const command = process.platform === "win32" ? `${name}.cmd` : name;
  const result = spawnSync(command, args, {
    ...options,
    encoding: "utf8",
    stdio: "pipe",
    shell: process.platform === "win32",
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed:\n${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    );
  }
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

const toolPath = `${join(repoRoot, "node_modules", ".bin")}${delimiter}${process.env.PATH ?? ""}`;

try {
  mkdirSync(packDir, { recursive: true });
  mkdirSync(installDir, { recursive: true });
  // prepack always deletes dist before rebuilding, so this proves the package
  // does not depend on a locally stale ignored artifact.
  npm(["pack", "--workspace", "@relaymessenger/cli", "--pack-destination", packDir]);
  const tarballs = readdirSync(packDir).filter((name) => name.endsWith(".tgz"));
  assert.equal(tarballs.length, 1, "expected exactly one relaymessenger tarball");
  const tarball = join(packDir, tarballs[0]);

  writeFileSync(
    join(temp, "package.json"),
    `${JSON.stringify({ name: "relaymessenger-installed-smoke", private: true }, null, 2)}\n`,
  );
  npm(["install", "--no-audit", "--no-fund", tarball], temp);

  const installed = join(temp, "node_modules", "@relaymessenger", "cli");
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
    existsSync(join(temp, "node_modules", ".bin", process.platform === "win32" ? "relaymessenger.cmd" : "relaymessenger")),
    true,
    "npm did not install the relaymessenger executable",
  );

  const pkg = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
  assert.equal(pkg.bin.relaymessenger, "dist/cli.js");
  assert.equal(pkg.engines.node, ">=22.18");
  assert.equal(pkg.license, "MIT");
  // The packed adapter pins must stay exact and match the workspace manifest.
  // Comparing against the manifest instead of a literal keeps dependency bumps
  // from failing this smoke for no reason.
  const sourcePkg = JSON.parse(
    readFileSync(join(repoRoot, "packages", "relaymessenger", "package.json"), "utf8"),
  );
  for (const adapter of ["@agentclientprotocol/claude-agent-acp", "@agentclientprotocol/codex-acp"]) {
    const pinned = sourcePkg.dependencies[adapter];
    assert.match(
      pinned ?? "",
      /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
      `${adapter} must be pinned to an exact version, found ${pinned ?? "no dependency"}`,
    );
    assert.equal(pkg.dependencies[adapter], pinned, `${adapter} pin must survive packing`);
  }

  const help = execFileSync(process.execPath, [join(installed, "dist", "cli.js"), "--help"], {
    cwd: installDir,
    encoding: "utf8",
  });
  assert.match(help, /relaymessenger pair/);
  assert.match(help, /relaymessenger start/);
  assert.doesNotMatch(help, /staging/i);

  const smokeHome = join(temp, "home");
  const smokeRelayHome = join(smokeHome, ".relaymessenger");
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
        RELAYMESSENGER_HOME: smokeRelayHome,
        PATH: toolPath,
      },
    },
  );
  assert.match(installClaude, /Installed bundled Claude plugin relay@relaymessenger-bundled/);
  assert.doesNotMatch(installClaude, /rly_pack_smoke_secret/);
  assert.match(
    readFileSync(join(smokeHome, ".claude", "channels", "relay", ".env"), "utf8"),
    /RELAY_AGENT_TOKEN=rly_pack_smoke_secret/,
  );
  const claudeEnv = {
    ...process.env,
    HOME: smokeHome,
    USERPROFILE: smokeHome,
    PATH: toolPath,
  };
  const claudePlugins = JSON.parse(cli("claude", ["plugin", "list", "--json"], {
    cwd: installDir,
    env: claudeEnv,
  }).stdout);
  const relayClaude = claudePlugins.find((plugin) => plugin.id === "relay@relaymessenger-bundled");
  assert.ok(relayClaude?.installPath, "bundled Claude plugin was not installed");
  assert.equal(existsSync(join(relayClaude.installPath, "commands", "configure.md")), true);
  assert.doesNotMatch(relayClaude.installPath, /integrations[/\\]claude-code/);
  rmSync(join(installed, "claude-plugin"), { recursive: true, force: true });
  cli("claude", ["plugin", "validate", relayClaude.installPath, "--strict"], {
    cwd: installDir,
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
        RELAYMESSENGER_HOME: smokeRelayHome,
        PATH: toolPath,
      },
    },
  );
  assert.match(installOpenClaw, /Installed bundled Relay plugin into OpenClaw/);
  assert.doesNotMatch(installOpenClaw, /rly_pack_smoke_secret/);
  const openclawEnv = {
    ...process.env,
    HOME: openclawHome,
    USERPROFILE: openclawHome,
    PATH: toolPath,
  };
  const openclawConfig = JSON.parse(
    readFileSync(join(openclawHome, ".openclaw", "openclaw.json"), "utf8"),
  );
  assert.equal(typeof openclawConfig.meta?.lastTouchedVersion, "string");
  // beta.5 migrated lastTouchedAt to shared machine state; the JSON config
  // retains only the compatibility-enforced writer version.
  assert.equal(openclawConfig.meta?.lastTouchedAt, undefined);
  const openclawList = cli("openclaw", ["plugins", "list", "--json"], {
    cwd: installDir,
    env: openclawEnv,
  });
  assert.doesNotMatch(openclawList.stderr, /Config observe anomaly/);
  const openclawPlugins = JSON.parse(openclawList.stdout);
  assert.ok(openclawPlugins.plugins?.some((plugin) => plugin.id === "relay"), "OpenClaw did not load Relay");
  const openclawInspect = JSON.parse(cli("openclaw", ["plugins", "inspect", "relay", "--json"], {
    cwd: installDir,
    env: openclawEnv,
  }).stdout);
  assert.equal(openclawInspect.install?.source, "npm");
  assert.equal(openclawInspect.install?.artifactKind, "npm-pack");
  assert.match(
    openclawInspect.install?.sourcePath ?? "",
    /[\\/]installed-plugins[\\/]openclaw[\\/][a-f0-9]{24}[\\/]relay-openclaw-plugin\.tgz$/,
  );
  assert.match(
    openclawInspect.install?.installPath ?? "",
    /[\\/]\.openclaw[\\/]npm[\\/]projects[\\/].+[\\/]node_modules[\\/]@relaymessenger[\\/]openclaw-plugin$/,
  );
  const openclawPluginRequire = createRequire(
    join(openclawInspect.install.installPath, "package.json"),
  );
  // Compare against what the plugin declares, never a literal. The check exists
  // to prove the packed tarball resolves its own pinned dependency, and a
  // hardcoded version turns every routine Dependabot bump into a red Required
  // CI even though nothing is actually broken.
  const declaredFsSafe = JSON.parse(
    readFileSync(join(repoRoot, "integrations", "openclaw", "package.json"), "utf8"),
  ).dependencies?.["@openclaw/fs-safe"];
  assert.ok(declaredFsSafe, "the plugin no longer declares @openclaw/fs-safe");
  // The pin is exact today. If it is ever loosened to a range, the resolved
  // version is whatever npm picked and there is nothing to assert.
  if (/^\d+\.\d+\.\d+/.test(declaredFsSafe)) {
    assert.equal(
      openclawPluginRequire("@openclaw/fs-safe/package.json").version,
      declaredFsSafe,
      "managed OpenClaw install did not resolve Relay's declared state dependency",
    );
  }
  rmSync(join(installed, "openclaw-plugin"), { recursive: true, force: true });
  const afterSourceRemoval = cli("openclaw", ["plugins", "list", "--json"], {
    cwd: installDir,
    env: openclawEnv,
  });
  assert.doesNotMatch(afterSourceRemoval.stderr, /Config observe anomaly/);
  const openclawAfterSourceRemoval = JSON.parse(afterSourceRemoval.stdout);
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

  process.stdout.write(`relaymessenger installed-tarball smoke passed (${tarballs[0]})\n`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
