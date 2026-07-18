import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
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
  run(npm, ["pack", ".", "--pack-destination", scratch], root);
  const archives = readdirSync(scratch).filter((name) => name.endsWith(".tgz"));
  if (archives.length !== 1) {
    throw new Error(`expected one npm archive, found ${archives.length}`);
  }
  const archive = join(scratch, archives[0]);
  mkdirSync(installDir);
  run(npm, ["init", "--yes"], installDir);
  run(npm, ["install", "--ignore-scripts", "--omit=dev", archive], installDir);

  const installedRoot = join(installDir, "node_modules", "relay-claude-channel");
  const runtime = join(installedRoot, "runtime", "server.mjs");
  const manifest = join(installedRoot, ".claude-plugin", "plugin.json");
  if (!existsSync(runtime) || !existsSync(manifest)) {
    throw new Error("installed archive is missing the bundled runtime or Claude plugin manifest");
  }
  const smoke = run(process.execPath, [runtime, "--version"], installDir);
  if (smoke.stdout.trim() !== "0.2.0") {
    throw new Error(`unexpected installed runtime version: ${JSON.stringify(smoke.stdout.trim())}`);
  }
  process.stdout.write(`installed ${basename(archive)} and loaded bundled runtime ${smoke.stdout.trim()}\n`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
