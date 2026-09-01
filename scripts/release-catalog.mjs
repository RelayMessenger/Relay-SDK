import assert from "node:assert/strict";
import { appendFileSync, readFileSync } from "node:fs";

const valueAfter = (name) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};

const key = valueAfter("--key");
const output = process.env.GITHUB_OUTPUT;
const catalog = {
  sdk: {
    directory: "packages/sdk",
    workspace: "@relaymessenger/sdk",
    validate: "validate:sdk",
  },
  "chat-sdk-adapter": {
    directory: "packages/chat-sdk-adapter",
    workspace: "@relaymessenger/chat-sdk-adapter",
    validate: "validate:chat-sdk",
  },
  cli: {
    directory: "packages/cli",
    workspace: "@relaymessenger/cli",
    validate: "validate:cli",
  },
  mcp: {
    directory: "packages/mcp",
    workspace: "@relaymessenger/mcp",
    validate: "validate:mcp",
  },
  openclaw: {
    directory: "packages/openclaw",
    workspace: "@relaymessenger/openclaw-plugin",
    validate: "validate:openclaw",
  },
  "claude-code": {
    directory: "packages/claude-code",
    workspace: "relay-claude-channel",
    validate: "validate:claude-code",
  },
};

assert.ok(key && key in catalog, `Unknown release package: ${key}`);
const selected = catalog[key];
const manifest = JSON.parse(
  readFileSync(`${selected.directory}/package.json`, "utf8"),
);
assert.equal(manifest.name, selected.workspace);
assert.match(manifest.version, /^\d+\.\d+\.\d+-staging\.\d+$/);
assert.equal(manifest.publishConfig?.tag, "staging");
assert.equal(manifest.publishConfig?.access, "public");
assert.equal(
  manifest.repository?.url,
  "git+https://github.com/RelayMessenger/Relay-SDK.git",
);
assert.equal(manifest.repository?.directory, selected.directory);

const resolved = {
  ...selected,
  key,
  version: manifest.version,
};
if (output) {
  for (const [name, value] of Object.entries(resolved)) {
    appendFileSync(output, `${name}=${value}\n`);
  }
}
console.log(JSON.stringify(resolved));
