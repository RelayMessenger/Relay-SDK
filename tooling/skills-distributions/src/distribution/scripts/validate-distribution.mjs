#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv[2];
assert.ok(["manifest", "content"].includes(mode), "choose manifest or content");

const json = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));
const sha256 = (path) =>
  createHash("sha256").update(readFileSync(join(root, path))).digest("hex");

const provenance = json(".relay-source.json");
const host = provenance.distribution;
assert.ok(["codex", "cursor"].includes(host));
assert.match(provenance.source_commit, /^[0-9a-f]{40}$/);
assert.equal(provenance.source_branch, "staging");
assert.equal(
  provenance.source_repository,
  "https://github.com/RelayMessenger/Relay-SDK",
);
assert.equal(
  provenance.generator,
  "tooling/skills-distributions/scripts/build-distribution.py",
);

const skillRoot =
  host === "codex" ? "plugins/relay/skills/relay" : "skills/relay";
const lock = json("RELAY_V1_LOCK.json");

if (mode === "manifest") {
  const packageJson = json("package.json");
  assert.equal(packageJson.private, true);
  assert.equal(packageJson.engines.node, ">=22.22.3");

  if (host === "codex") {
    const readme = readFileSync(join(root, "README.md"), "utf8");
    const plugin = json("plugins/relay/.codex-plugin/plugin.json");
    const mcp = json("plugins/relay/.mcp.json");
    const marketplace = json(".agents/plugins/marketplace.json");
    assert.equal(plugin.name, "relay");
    assert.equal(plugin.skills, "./skills/");
    assert.equal(plugin.mcpServers, "./.mcp.json");
    assert.equal(plugin.version, packageJson.version);
    assert.equal(mcp.mcpServers.relayDocs.type, "http");
    assert.equal(mcp.mcpServers.relayDocs.url, "https://docs.relayapp.im/mcp");
    assert.equal(marketplace.plugins[0].source.path, "./plugins/relay");
    assert.equal(marketplace.plugins[0].policy.installation, "AVAILABLE");
    assert.equal(marketplace.plugins[0].policy.authentication, "ON_INSTALL");
    assert.match(readme, /Codex CLI `0\.152\.0`/);
    assert.match(readme, /codex plugin add relay@relay-plugin-marketplace/);
  } else {
    const plugin = json(".cursor-plugin/plugin.json");
    const mcp = json("mcp.json");
    const marketplace = json(".cursor-plugin/marketplace.json");
    assert.equal(plugin.name, "relay");
    assert.equal(plugin.skills, "./skills/");
    assert.equal(plugin.mcpServers, "./mcp.json");
    assert.equal(plugin.version, packageJson.version);
    assert.equal(mcp.mcpServers.relayDocs.type, "http");
    assert.equal(mcp.mcpServers.relayDocs.url, "https://docs.relayapp.im/mcp");
    assert.equal(marketplace.plugins[0].source, "./");
  }

  console.log(`validated ${host} manifests and provenance`);
  process.exit(0);
}

const walk = (directory) => {
  const result = [];
  for (const name of readdirSync(directory)) {
    if (name === ".git" || name === "node_modules") continue;
    const path = join(directory, name);
    const info = lstatSync(path);
    if (info.isDirectory()) result.push(...walk(path));
    else if (info.isFile()) result.push(relative(root, path));
  }
  return result.sort();
};

const ignoredAfterInstall = new Set([".relay-source.json", "package-lock.json"]);
const actualFiles = walk(root).filter((path) => !ignoredAfterInstall.has(path));
const expectedFiles = Object.keys(provenance.generated_files).sort();
assert.deepEqual(actualFiles, expectedFiles, "generated file inventory drifted");
for (const [path, digest] of Object.entries(provenance.generated_files)) {
  assert.equal(sha256(path), digest, `generated file changed: ${path}`);
}

assert.deepEqual(lock, provenance.relay_v1_lock);
assert.equal(lock.sdk.version, "0.3.0-staging.8");
assert.equal(lock.api.commit, "529db629aa679eefb12788dbf496d8058561ac18");
assert.equal(
  lock.api.openapi_sha256,
  "f9919ed4c63efd32197ea8861b3b879f6a9594645308e65ade25f6447b479bd9",
);
assert.equal(lock.docs.commit, "aae6a9f3ee8084820910761c8aa8a85ed2826dda");

const skillPath = join(root, skillRoot, "SKILL.md");
assert.ok(existsSync(skillPath));
const skill = readFileSync(skillPath, "utf8");
assert.match(skill, /name: relay/);
assert.match(skill, /locked Relay v1 contract/);

const references = [
  ...skill.matchAll(/\]\((references\/[^)]+)\)/g),
].map((match) => match[1]);
for (const target of references) {
  assert.ok(existsSync(join(root, skillRoot, target)), `missing ${target}`);
}

const textExtensions = new Set([
  ".json",
  ".md",
  ".mjs",
  ".py",
  ".sh",
  ".yaml",
  ".yml",
]);
const text = actualFiles
  .filter((path) => textExtensions.has(path.slice(path.lastIndexOf("."))))
  .map((path) => readFileSync(join(root, path), "utf8"))
  .join("\n");
const retired = [
  "po" + "lling",
  "conversa" + "tions",
  "long" + " poll",
  "/v1/" + "ev" + "ents",
  "@relaymessenger/" + "cli",
  "2026-" + "02-03",
  "relay" + " listen",
];
for (const term of retired) {
  assert.ok(!text.toLowerCase().includes(term), `retired content: ${term}`);
}
assert.doesNotMatch(text, /stream\s*=\s*true/i);

for (const marker of [
  "2026-08-30",
  "/v1/websocket",
  "POST /v1/contact_requests",
  "contactRequests.create",
  "relay.chats.messages.send",
  "relayApiOrigin(process.env.RELAY_API_URL)",
]) {
  assert.ok(text.includes(marker), `missing locked marker: ${marker}`);
}

for (const directory of ["channels", "commands", "hooks", "rules", "runtime"]) {
  assert.ok(!existsSync(join(root, directory)), `runtime content found: ${directory}`);
}

const examplePackage = json("examples/send-message/package.json");
assert.equal(
  examplePackage.dependencies["@relaymessenger/sdk"],
  lock.sdk.version,
);

console.log(`validated ${host} generated content and locked Relay v1 markers`);
