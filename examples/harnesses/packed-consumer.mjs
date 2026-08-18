#!/usr/bin/env node
/**
 * Packed-consumer smoke: build core and import it from a fresh path resolution.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const build = spawnSync("npm", ["run", "build", "-w", "@relaymessenger/sdk"], {
  cwd: root,
  encoding: "utf8",
  stdio: "inherit",
});
if (build.status !== 0) process.exit(build.status ?? 1);

const require = createRequire(join(root, "packages/sdk/package.json"));
const pkg = require("./package.json");
if (pkg.name !== "@relaymessenger/sdk") {
  console.error("unexpected package name", pkg.name);
  process.exit(1);
}

const mod = await import(join(root, "packages/sdk/dist/index.js"));
if (typeof mod.createRelayClient !== "function") {
  console.error("createRelayClient missing from build");
  process.exit(1);
}
console.log("pack:check passed");
