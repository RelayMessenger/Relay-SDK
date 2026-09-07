import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
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
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    encoding: "utf8",
    shell: false,
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

const consumer = await mkdtemp(join(tmpdir(), "relay-cli-consumer-"));
await writeFile(
  join(consumer, "package.json"),
  JSON.stringify({ private: true, type: "module" }),
);
run("npm", ["install", "--ignore-scripts", tarball], { cwd: consumer });

const binDirectory = join(consumer, "node_modules", ".bin");
const relay = join(binDirectory, process.platform === "win32" ? "relay.cmd" : "relay");
const alias = join(
  binDirectory,
  process.platform === "win32" ? "relaymessenger.cmd" : "relaymessenger",
);
if (process.platform !== "win32") {
  await chmod(relay, 0o755);
  await chmod(alias, 0o755);
}
const secret = "rly_tarball_smoke_secret_0123456789";
const home = await mkdtemp(join(tmpdir(), "relay-cli-home-"));
const env = {
  ...process.env,
  HOME: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  RELAY_AGENT_TOKEN: secret,
  PATH: `${binDirectory}${delimiter}${process.env.PATH ?? ""}`,
};
const version = run(relay, ["--version"], { cwd: consumer, env });
assert.equal(version.stdout.trim(), sourceManifest.version);
const aliasVersion = run(alias, ["--version"], { cwd: consumer, env });
assert.equal(aliasVersion.stdout, version.stdout);
const doctor = run(relay, ["doctor", "--offline"], { cwd: consumer, env });
assert.match(doctor.stdout, /"ok": true/);
assert.equal(`${doctor.stdout}${doctor.stderr}`.includes(secret), false);

const installedManifest = JSON.parse(
  await readFile(join(consumer, "node_modules", "@relaymessenger", "cli", "package.json")),
);
assert.equal(installedManifest.name, "@relaymessenger/cli");
assert.equal(installedManifest.dependencies["@relaymessenger/sdk"], "0.3.0-staging.8");

console.log(`CLI tarball install smoke OK: ${tarball}`);
