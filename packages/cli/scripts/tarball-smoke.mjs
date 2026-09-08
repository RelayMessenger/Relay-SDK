import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceManifest = JSON.parse(
  await readFile(join(root, "package.json"), "utf8"),
);
const release = resolve(root, ".release-tmp", "cli-pack-smoke");
await rm(release, { recursive: true, force: true });
await mkdir(release, { recursive: true });

const run = (command, args, options = {}) => {
  // Only npm/installed .cmd shims need a shell. Quote our fixed smoke arguments
  // so Windows paths containing spaces do not change argument boundaries.
  const shell = process.platform === "win32" && (command === "npm" || /\.cmd$/i.test(command));
  const quote = (value) => `"${value.replaceAll('"', '""')}"`;
  const result = spawnSync(shell ? quote(command) : command, shell ? args.map(quote) : args, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    encoding: "utf8",
    shell,
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status})\n`
      + `${result.stdout}\n${result.stderr}`,
    );
  }
  return result;
};

run("npm", [
  "pack",
  "--ignore-scripts",
  "--pack-destination",
  release,
]);
const tarballs = (await readdir(release)).filter((name) => name.endsWith(".tgz"));
assert.equal(tarballs.length, 1, "expected exactly one CLI tarball");
const tarball = resolve(release, tarballs[0]);
const listing = run("tar", ["-tzf", tarball]).stdout.trim().split("\n").sort();
for (const required of [
  "package/LICENSE",
  "package/README.md",
  "package/dist/cli.js",
  "package/package.json",
]) {
  assert.ok(listing.includes(required), `tarball is missing ${required}`);
}
for (const path of listing) {
  assert.doesNotMatch(path, /(?:^|\/)(?:\.env|\.npmrc|src|test|contracts)(?:\/|$)/);
}

const consumer = await mkdtemp(join(tmpdir(), "relay cli consumer-"));
await writeFile(
  join(consumer, "package.json"),
  JSON.stringify({ private: true, type: "module" }),
);
const sdkRelease = join(release, "sdk");
await mkdir(sdkRelease);
run("npm", ["pack", "--ignore-scripts", "--pack-destination", sdkRelease], { cwd: resolve(root, "../sdk") });
const sdkTarballs = (await readdir(sdkRelease)).filter((name) => name.endsWith(".tgz"));
assert.equal(sdkTarballs.length, 1);
run("npm", ["install", "--ignore-scripts", join(sdkRelease, sdkTarballs[0]), tarball], { cwd: consumer });

const binDirectory = join(consumer, "node_modules", ".bin");
const relay = join(binDirectory, process.platform === "win32" ? "relay.cmd" : "relay");
const alias = join(
  binDirectory,
  process.platform === "win32" ? "relaymessenger.cmd" : "relaymessenger",
);
const secret = "rly_tarball_smoke_secret_0123456789";
const home = await mkdtemp(join(tmpdir(), "relay cli home-"));
const env = {
  ...process.env,
  HOME: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  RELAY_AGENT_TOKEN: secret,
  RELAY_CONFIG_PATH: join(home, "config.json"),
  RELAY_PROFILE: "default",
  PATH: `${binDirectory}${delimiter}${process.env.PATH ?? ""}`,
};
const version = run(relay, ["--version"], { cwd: consumer, env });
assert.equal(version.stdout.trim(), sourceManifest.version);
const aliasVersion = run(alias, ["--version"], { cwd: consumer, env });
assert.equal(aliasVersion.stdout, version.stdout);
const agentsHelp = run(relay, ["agents", "--help"], { cwd: consumer, env });
for (const command of ["create", "list", "delete"]) assert.match(agentsHelp.stdout, new RegExp(command));
run(process.execPath, [join(root, "scripts/agent-tarball-consumer.mjs"), consumer, home], { cwd: consumer, env });
const doctor = run(relay, ["doctor", "--offline"], { cwd: consumer, env });
assert.match(doctor.stdout, /"ok": true/);
assert.equal(`${doctor.stdout}${doctor.stderr}`.includes(secret), false);

const installedManifest = JSON.parse(
  await readFile(join(consumer, "node_modules", "@relaymessenger", "cli", "package.json")),
);
assert.equal(installedManifest.name, "@relaymessenger/cli");
assert.equal(
  installedManifest.dependencies["@relaymessenger/sdk"],
  sourceManifest.dependencies["@relaymessenger/sdk"],
);

console.log(`CLI tarball install smoke OK: ${tarball}`);
