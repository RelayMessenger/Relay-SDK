import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path));
const json = (path) => JSON.parse(read(path).toString("utf8"));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

// A staging build is `X.Y.Z-staging.N`. The release job on main derives the
// plain `X.Y.Z` from it and says so with RELAY_RELEASE=1; a plain version
// without that flag is a hand edit and fails here.
const releaseVersionShape = /^\d+\.\d+\.\d+$/u;
const stagingVersionShape = /^\d+\.\d+\.\d+-staging\.\d+$/u;
const versionIsAllowed = (version) =>
  stagingVersionShape.test(version)
  || (process.env.RELAY_RELEASE === "1" && releaseVersionShape.test(version));
const packageJSON = json("package.json");
const plugin = json(".claude-plugin/plugin.json");
const packagedPlugin = json("plugin/.claude-plugin/plugin.json");
const marketplace = json(".claude-plugin/marketplace.json");
const runtime = read("runtime/server.mjs");
const packagedRuntime = read("plugin/runtime/server.mjs");

assert.ok(
  versionIsAllowed(packageJSON.version),
  `${packageJSON.version} is neither a staging prerelease nor a RELAY_RELEASE=1 release version`,
);
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
assert.ok(runtime.includes(Buffer.from("portable text remains bullets")), "rebuild runtime from canonical selection guidance");
assert.ok(runtime.includes(Buffer.from("checking sends nothing and only the submit does")));
assert.ok(runtime.includes(Buffer.from("draw a checkmark in place of each bullet")));
assert.ok(!runtime.includes(Buffer.from("light-blue")), "stale selection UX in runtime");
assert.ok(
  runtime.includes(Buffer.from(JSON.stringify(packageJSON.version))),
  "generated runtime does not embed the package version",
);
assert.ok(
  !runtime.includes(Buffer.from("@a2a-js/sdk/dist/")),
  "generated runtime bundles the A2A client; keep @a2a-js/sdk external (scripts/build.mjs)",
);
assert.doesNotMatch(
  runtime.toString("utf8"),
  /(?:\.\.\/)+(?:node_modules|sdk)\//u,
  "generated runtime contains install-layout-dependent module labels",
);

process.stdout.write(
  `artifact identity passed: ${packageJSON.name}@${packageJSON.version} runtime sha256=${digest(runtime)}\n`,
);
