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
    RELAY_API_URL: "http://127.0.0.1:1",
    RELAY_AGENT_TOKEN: "mcp-protocol-fixture-not-a-real-token",
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
  assert.deepEqual(listed.tools.map(tool => tool.name).sort(), ["execute", "search_docs"]);
  assert.ok(listed.tools.every(tool => !JSON.stringify(tool.inputSchema).toLowerCase().includes("token")));
  const docs = await client.callTool({ name: "search_docs", arguments: { query: "send message", language: "typescript" } });
  assert.notEqual(docs.isError, true);
  assert.match(JSON.stringify(docs), /client\.chats\.messages\.send/);
  const executed = await client.callTool({ name: "execute", arguments: { code: "async function run(client) { const answer: number = 4; console.log(answer); return { answer, hasClient: !!client }; }" } });
  assert.notEqual(executed.isError, true);
  assert.deepEqual(executed.structuredContent.result, { answer: 4, hasClient: true });
  const invalid = await client.callTool({ name: "execute", arguments: { code: "not valid code !!" } });
  assert.equal(invalid.isError, true);
  console.log(
    `MCP modern stdio protocol OK: ${client.getNegotiatedProtocolVersion()}`,
  );
} finally {
  await client.close().catch(() => {});
}
