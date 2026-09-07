import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJSON = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const scratch = mkdtempSync(join(tmpdir(), "relay-claude-pack-"));
const installDir = join(scratch, "installed");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: "pipe" });
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    throw new Error(`${command} ${args.join(" ")} failed with status ${result.status}`);
  }
  return result;
}

try {
  run(npm, ["pack", ".", "--ignore-scripts", "--pack-destination", scratch], root);
  const archives = readdirSync(scratch).filter((name) => name.endsWith(".tgz"));
  if (archives.length !== 1 || !archives[0]) {
    throw new Error(`expected one npm archive, found ${archives.length}`);
  }
  const archive = join(scratch, archives[0]);
  mkdirSync(installDir);
  run(npm, ["init", "--yes"], installDir);
  run(
    npm,
    ["install", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund", archive],
    installDir,
  );
  const installedRoot = join(installDir, "node_modules", "relay-claude-channel");
  const required = [
    "runtime/server.mjs",
    "plugin/runtime/server.mjs",
    "plugin/.claude-plugin/plugin.json",
    "plugin/.mcp.json",
    "plugin/commands/configure.md",
    ".claude-plugin/plugin.json",
    ".claude-plugin/marketplace.json",
    ".mcp.json",
    "commands/configure.md",
    "contracts/relay-v1.lock.json",
    "README.md",
    "LICENSE",
    "NOTICE",
  ];
  for (const path of required) {
    if (!existsSync(join(installedRoot, path))) throw new Error(`installed archive is missing ${path}`);
  }
  const dryRun = JSON.parse(
    run(npm, ["pack", ".", "--dry-run", "--json", "--ignore-scripts"], root).stdout,
  );
  const dryRunEntry = Array.isArray(dryRun) ? dryRun[0] : Object.values(dryRun)[0];
  if (!dryRunEntry || !Array.isArray(dryRunEntry.files)) {
    throw new Error("npm pack --dry-run did not return a file inventory");
  }
  const packedFiles = dryRunEntry.files.map((entry) => entry.path);
  for (const forbidden of [".env", "server.ts", "src/", "test/", "node_modules/", "package-lock.json"]) {
    if (packedFiles.some((path) => path === forbidden || path.startsWith(forbidden))) {
      throw new Error(`npm archive contains forbidden development or secret path ${forbidden}`);
    }
  }
  const runtime = join(installedRoot, "runtime", "server.mjs");
  const pluginRuntime = join(installedRoot, "plugin", "runtime", "server.mjs");
  const sourceRuntime = readFileSync(join(root, "runtime", "server.mjs"));
  const runtimeBytes = readFileSync(runtime);
  const runtimeHash = createHash("sha256").update(runtimeBytes).digest("hex");
  const sourceRuntimeHash = createHash("sha256").update(sourceRuntime).digest("hex");
  const pluginRuntimeHash = createHash("sha256")
    .update(readFileSync(pluginRuntime))
    .digest("hex");
  if (runtimeHash !== sourceRuntimeHash || runtimeHash !== pluginRuntimeHash) {
    throw new Error("packed runtime hashes drifted from the reviewed generated runtime");
  }
  const version = run(process.execPath, [runtime, "--version"], installDir).stdout.trim();
  if (version !== packageJSON.version) throw new Error(`installed runtime reported ${version}`);
  const installedManifest = JSON.parse(readFileSync(join(installedRoot, "package.json"), "utf8"));
  const installedPlugin = JSON.parse(
    readFileSync(join(installedRoot, "plugin", ".claude-plugin", "plugin.json"), "utf8"),
  );
  if (installedPlugin.version !== installedManifest.version) {
    throw new Error("installed plugin manifest version drifted");
  }
  if (JSON.stringify(installedManifest.publishConfig) !== JSON.stringify(packageJSON.publishConfig)) {
    throw new Error("installed publishConfig drifted");
  }
  const require = createRequire(join(installedRoot, "package.json"));
  const installedSdk = require("@relaymessenger/sdk/package.json");
  if (installedSdk.version !== packageJSON.dependencies["@relaymessenger/sdk"]) {
    throw new Error(`installed SDK version ${installedSdk.version} drifted`);
  }
  process.stdout.write(
    `installed-tarball smoke passed: ${basename(archive)}, runtime ${version} sha256=${runtimeHash}, SDK ${installedSdk.version}, ${packedFiles.length} package files\n`,
  );
} finally {
  rmSync(scratch, { recursive: true, force: true, maxRetries: 10 });
}
