import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path));
const json = (path) => JSON.parse(read(path).toString("utf8"));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

const packageJSON = json("package.json");
const plugin = json(".claude-plugin/plugin.json");
const packagedPlugin = json("plugin/.claude-plugin/plugin.json");
const marketplace = json(".claude-plugin/marketplace.json");
const runtime = read("runtime/server.mjs");
const packagedRuntime = read("plugin/runtime/server.mjs");

assert.match(packageJSON.version, /^\d+\.\d+\.\d+-staging\.\d+$/u);
assert.equal(plugin.version, packageJSON.version);
assert.equal(packagedPlugin.version, packageJSON.version);
assert.equal(marketplace.plugins?.[0]?.version, packageJSON.version);
assert.deepEqual(packageJSON.publishConfig, {
  access: "public",
  registry: "https://registry.npmjs.org/",
  tag: "staging",
  provenance: true,
});
assert.deepEqual(runtime, packagedRuntime, "root and marketplace runtimes differ");
assert.ok(
  runtime.includes(Buffer.from(JSON.stringify(packageJSON.version))),
  "generated runtime does not embed the package version",
);

process.stdout.write(
  `artifact identity passed: ${packageJSON.name}@${packageJSON.version} runtime sha256=${digest(runtime)}\n`,
);
