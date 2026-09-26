// A Worker that hosts the Relay MCP server the way a hosted MCP does: the
// published entry point, QuickJS's WebAssembly handed in as a module, and a
// Relay client whose fetch is local. GET / runs one execute call end to end
// through an MCP client and answers with the tool result.
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import Relay from "@relaymessenger/sdk";
import quickjsWasmModule from "@jitl/quickjs-wasmfile-release-sync/wasm";
import { createRelayMcpServer } from "@relaymessenger/mcp";

const TOKEN = "rel_workerd_test_token_never_shown";

export const runExecute = async (code: string): Promise<unknown> => {
  const requests: string[] = [];
  const relay = new Relay({
    apiKey: TOKEN,
    baseURL: "https://api.relay.test",
    maxRetries: 0,
    fetch: async (input) => {
      requests.push(String(input));
      return Response.json({ handle: "workerd", first_name: "Workerd" });
    },
  });
  const server = createRelayMcpServer({
    resolveClient: async () => ({ client: relay, secrets: [TOKEN] }),
    collectSecrets: async () => [TOKEN],
    executionRuntime: { quickjsWasmModule },
  });
  const client = new Client({ name: "relay-workerd-test", version: "1.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  try {
    const result = await client.callTool({ name: "execute", arguments: { code } });
    return { result, requests };
  } finally {
    await client.close();
    await server.close();
  }
};

export default {
  async fetch(): Promise<Response> {
    const outcome = await runExecute(
      "async function run(client) { const card: { handle: string } = await client.contactCard.retrieve(); return card.handle; }",
    );
    return Response.json(outcome);
  },
} satisfies ExportedHandler;
