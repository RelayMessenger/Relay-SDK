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
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceManifest = JSON.parse(
  await readFile(join(root, "package.json"), "utf8"),
);
const release = resolve(root, ".release-tmp", "mcp-pack-smoke");
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
assert.equal(tarballs.length, 1);
const tarball = resolve(release, tarballs[0]);
const listing = run("tar", ["-tzf", tarball]).stdout.trim().split("\n").sort();
for (const required of [
  "package/LICENSE",
  "package/README.md",
  "package/dist/auth.js",
  "package/dist/cli.js",
  "package/dist/server.js",
  "package/package.json",
]) {
  assert.ok(listing.includes(required), `tarball is missing ${required}`);
}
for (const path of listing) {
  assert.doesNotMatch(path, /(?:^|\/)(?:\.env|\.npmrc|src|test|contracts)(?:\/|$)/);
}

const consumer = await mkdtemp(join(tmpdir(), "relay-mcp-consumer-"));
await writeFile(
  join(consumer, "package.json"),
  JSON.stringify({ private: true, type: "module" }),
);
run("npm", ["install", "--ignore-scripts", tarball], { cwd: consumer });
const bin = join(
  consumer,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "relay-mcp.cmd" : "relay-mcp",
);
if (process.platform !== "win32") await chmod(bin, 0o755);
assert.equal(
  run(bin, ["--version"], { cwd: consumer }).stdout.trim(),
  sourceManifest.version,
);

const home = await mkdtemp(join(tmpdir(), "relay-mcp-installed-home-"));
const transport = new StdioClientTransport({
  command: bin,
  env: {
    HOME: home,
    PATH: process.env.PATH ?? "",
    XDG_CONFIG_HOME: join(home, ".config"),
  },
  stderr: "pipe",
});
const client = new Client(
  { name: "installed-relay-mcp-smoke", version: "1.0.0" },
  { versionNegotiation: { mode: "auto", probe: { timeoutMs: 5_000 } } },
);
try {
  await client.connect(transport, { timeout: 10_000 });
  assert.equal(client.getProtocolEra(), "modern");
  assert.equal((await client.listTools()).tools.length, 16);
} finally {
  await client.close().catch(() => {});
}

const installedManifest = JSON.parse(
  await readFile(
    join(consumer, "node_modules", "@relaymessenger", "mcp", "package.json"),
  ),
);
assert.equal(installedManifest.dependencies["@modelcontextprotocol/server"], "2.0.0");
assert.equal(installedManifest.dependencies["@relaymessenger/sdk"], "0.3.0-staging.5");
assert.equal(installedManifest.dependencies["@modelcontextprotocol/client"], undefined);
console.log(`MCP tarball install/protocol smoke OK: ${tarball}`);
