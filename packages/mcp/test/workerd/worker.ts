// A Worker that hosts the Relay MCP server the way a hosted MCP does: the
// published entry point and a Relay client whose fetch is local. GET / runs
// one execute call end to end through an MCP client in QuickJS (its
// WebAssembly handed in as a module); POST /executor runs the posted code in
// a Dynamic Worker through Cloudflare Code Mode's DynamicWorkerExecutor over
// the LOADER Worker Loader binding.
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import Relay from "@relaymessenger/sdk";
import quickjsWasmModule from "@jitl/quickjs-wasmfile-release-sync/wasm";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { createRelayMcpServer, type ExecutionRuntime } from "@relaymessenger/mcp";

const TOKEN = "rel_workerd_test_token_never_shown";

export const runExecute = async (
  code: string,
  executionRuntime: ExecutionRuntime = { quickjsWasmModule },
): Promise<unknown> => {
  const requests: string[] = [];
  const relay = new Relay({
    apiKey: TOKEN,
    baseURL: "https://api.relay.test",
    maxRetries: 0,
    fetch: async (input) => {
      requests.push(String(input));
      if (String(input).includes("/v1/chats/missing")) {
        return Response.json({ error: { status: 404, code: 2001, message: "Chat was not found." } }, { status: 404 });
      }
      return Response.json({ handle: "workerd", first_name: "Workerd" });
    },
  });
  const server = createRelayMcpServer({
    resolveClient: async () => ({ client: relay, secrets: [TOKEN] }),
    collectSecrets: async () => [TOKEN],
    executionRuntime,
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
  async fetch(request: Request, env: { LOADER: WorkerLoader }): Promise<Response> {
    if (new URL(request.url).pathname === "/executor") {
      const executor = new DynamicWorkerExecutor({ loader: env.LOADER });
      return Response.json(await runExecute(await request.text(), { executor }));
    }
    const outcome = await runExecute(
      "async function run(client) { const card: { handle: string } = await client.contactCard.retrieve(); return card.handle; }",
    );
    return Response.json(outcome);
  },
} satisfies ExportedHandler<{ LOADER: WorkerLoader }>;
