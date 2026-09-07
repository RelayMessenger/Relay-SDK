import assert from "node:assert/strict";
import { appendFileSync, readFileSync } from "node:fs";
import { releaseEntry, releaseKeys } from "./release-packages.mjs";

const valueAfter = (name) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};

const key = valueAfter("--key");
const output = process.env.GITHUB_OUTPUT;

assert.ok(
  key && releaseKeys.includes(key),
  `Unknown release package: ${key}`,
);
const selected = releaseEntry(key);
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

// Only the scalar fields the staging workflow reads. The catalog also carries
// release-workflow data (tag prefix, workflow file, registry smoke) that must
// never reach GITHUB_OUTPUT, where a non-scalar would corrupt the file.
const resolved = {
  directory: selected.directory,
  workspace: selected.workspace,
  validate: selected.validate,
  key,
  version: manifest.version,
};
if (output) {
  for (const [name, value] of Object.entries(resolved)) {
    appendFileSync(output, `${name}=${value}\n`);
  }
}
console.log(JSON.stringify(resolved));
