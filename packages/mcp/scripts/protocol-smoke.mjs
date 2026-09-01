import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const home = await mkdtemp(join(tmpdir(), "relay-mcp-protocol-"));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve("dist/cli.js")],
  env: {
    HOME: home,
    PATH: process.env.PATH ?? "",
    XDG_CONFIG_HOME: join(home, ".config"),
  },
  stderr: "pipe",
});
const client = new Client(
  { name: "relay-mcp-protocol-smoke", version: "1.0.0" },
  {
    versionNegotiation: {
      mode: "auto",
      probe: { timeoutMs: 5_000, maxRetries: 0 },
    },
  },
);

try {
  await client.connect(transport, { timeout: 10_000 });
  assert.equal(client.getProtocolEra(), "modern");
  assert.match(client.getNegotiatedProtocolVersion() ?? "", /^2026-/);
  const listed = await client.listTools();
  assert.equal(listed.tools.length, 16);
  assert.ok(listed.tools.some((tool) => tool.name === "relay_send_message"));
  assert.ok(listed.tools.some((tool) => tool.name === "relay_create_contact_request"));
  assert.equal(
    listed.tools.some((tool) =>
      JSON.stringify(tool.inputSchema).toLowerCase().includes("token")),
    false,
  );
  const invalid = await client.callTool({
    name: "relay_get_chat",
    arguments: { chat_id: "not-a-uuid" },
  });
  assert.equal(invalid.isError, true);
  assert.match(JSON.stringify(invalid), /invalid/i);
  console.log(
    `MCP modern stdio protocol OK: ${client.getNegotiatedProtocolVersion()}`,
  );
} finally {
  await client.close().catch(() => {});
}
