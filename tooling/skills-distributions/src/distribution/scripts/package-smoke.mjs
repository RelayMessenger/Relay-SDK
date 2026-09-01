#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const { stdout } = await run(
  "npm",
  ["pack", "--dry-run", "--json", "--ignore-scripts"],
  { maxBuffer: 10 * 1024 * 1024 },
);
const report = JSON.parse(stdout)[0];
const files = new Set(report.files.map((entry) => entry.path));

assert.ok(files.has("README.md"));
assert.ok(files.has("RELAY_V1_LOCK.json"));
assert.ok(files.has("examples/send-message/index.mjs"));
assert.ok(files.has("scripts/test-mcp-search.mjs"));
assert.ok(
  files.has("plugins/relay/.codex-plugin/plugin.json") ||
    files.has(".cursor-plugin/plugin.json"),
  "host manifest is missing from package",
);
assert.ok(
  [...files].some((path) => path.endsWith("skills/relay/SKILL.md")),
  "Relay skill is missing from package",
);
assert.ok(
  ![...files].some((path) => path.includes("node_modules")),
  "package contains installed dependencies",
);

console.log(`verified package inventory with ${files.size} files`);
