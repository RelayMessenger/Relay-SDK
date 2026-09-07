import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const home = await mkdtemp(join(tmpdir(), "relay-mcp-inspector-"));
const require = createRequire(import.meta.url);
const inspectorManifestPath = require.resolve(
  "@modelcontextprotocol/inspector/package.json",
);
const inspectorManifest = JSON.parse(
  await readFile(inspectorManifestPath, "utf8"),
);
const inspector = resolve(
  dirname(inspectorManifestPath),
  inspectorManifest.bin["mcp-inspector"],
);
const result = spawnSync(
  process.execPath,
  [
    inspector,
    "--cli",
    process.execPath,
    resolve("dist/cli.js"),
    "--method",
    "tools/list",
    "--format",
    "json",
    "--strict",
    "--connect-timeout",
    "10000",
  ],
  {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      MCP_CLIENT_CONFIG_PATH: join(home, "inspector-client.json"),
    },
    encoding: "utf8",
    shell: false,
    timeout: 30_000,
  },
);

assert.equal(
  result.status,
  0,
  `Inspector failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
);
const parsed = JSON.parse(result.stdout);
const tools = parsed.result?.tools ?? parsed.tools;
assert.ok(Array.isArray(tools), "Inspector did not return a tools array");
assert.equal(tools.length, 16);
assert.ok(tools.some((tool) => tool.name === "relay_react_to_message"));
console.log("MCP Inspector v2 tools/list --strict OK");
