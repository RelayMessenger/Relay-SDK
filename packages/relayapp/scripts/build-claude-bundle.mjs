import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageRoot, "../..");
const integrationRoot = join(repoRoot, "integrations", "claude-code");
const target = join(packageRoot, "claude-plugin");
const scratch = mkdtempSync(join(tmpdir(), "relayapp-claude-bundle-"));
const generated = join(scratch, "claude-plugin");
const marketplace = join(generated, "marketplace");
const plugin = join(marketplace, "plugins", "relay");
const openclawGenerated = join(scratch, "openclaw-plugin");
const openclawTarget = join(packageRoot, "openclaw-plugin");

function run(command, args, cwd = repoRoot, env = process.env) {
  const resolvedCommand = process.platform === "win32"
    && !/[\\/]/.test(command)
    && !/\.(?:exe|cmd|bat)$/i.test(command)
    ? `${command}.cmd`
    : command;
  const result = spawnSync(resolvedCommand, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: "pipe",
    shell: process.platform === "win32" && /\.(?:cmd|bat)$/i.test(resolvedCommand),
    windowsHide: true,
  });
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    throw new Error(
      `${resolvedCommand} ${args.join(" ")} failed with status ${result.status ?? "unknown"}`,
    );
  }
}

try {
  // Build from the owning TypeScript source immediately before copying. The
  // npm tarball can therefore never carry a stale development runtime.
  run(process.execPath, [join(integrationRoot, "scripts", "build.mjs")], integrationRoot);

  mkdirSync(join(marketplace, ".claude-plugin"), { recursive: true });
  mkdirSync(join(plugin, ".claude-plugin"), { recursive: true });
  mkdirSync(join(plugin, "commands"), { recursive: true });
  mkdirSync(join(plugin, "runtime"), { recursive: true });

  for (const relative of [
    ".claude-plugin/plugin.json",
    "commands/configure.md",
    "runtime/server.mjs",
    "README.md",
  ]) {
    const source = join(integrationRoot, relative);
    if (!existsSync(source)) throw new Error(`Claude bundle source is missing ${relative}`);
    cpSync(source, join(plugin, relative));
  }
  cpSync(join(repoRoot, "LICENSE"), join(plugin, "LICENSE"));

  const manifest = {
    name: "relayapp-bundled",
    description: "Bundled Relay channel plugin for Claude Code",
    owner: { name: "Relay" },
    plugins: [
      {
        name: "relay",
        source: "./plugins/relay",
        description:
          "Text your Claude Code from Relay: chat bridge and phone Allow/Deny permission relay",
      },
    ],
  };
  writeFileSync(
    join(marketplace, ".claude-plugin", "marketplace.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  // This exact CLI version is a dev dependency of relayapp, so strict
  // validation runs in every source pack and release lane.
  const claude = process.env.RELAYAPP_CLAUDE_BIN?.trim() || "claude";
  run(claude, ["plugin", "validate", plugin, "--strict"]);
  run(claude, ["plugin", "validate", marketplace, "--strict"]);

  rmSync(target, { recursive: true, force: true });
  renameSync(generated, target);
  mkdirSync(openclawGenerated, { recursive: true });
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  run(
    npm,
    [
      "pack",
      "--workspace",
      "@relayapp/openclaw-plugin",
      "--pack-destination",
      openclawGenerated,
    ],
    repoRoot,
    {
      ...process.env,
      // An outer `npm pack --dry-run` exports this lifecycle setting. The
      // nested pack is an artifact build, not a preview: it must still create
      // the OpenClaw archive that the outer relayapp manifest inspects.
      npm_config_dry_run: "false",
      NPM_CONFIG_DRY_RUN: "false",
    },
  );
  const openclawArchives = readdirSync(openclawGenerated).filter((name) => name.endsWith(".tgz"));
  if (openclawArchives.length !== 1) {
    throw new Error(`expected one generated OpenClaw archive, found ${openclawArchives.length}`);
  }
  rmSync(openclawTarget, { recursive: true, force: true });
  renameSync(openclawGenerated, openclawTarget);
  process.stdout.write(
    `generated and strictly validated Claude marketplace plus ${openclawArchives[0]}\n`,
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
