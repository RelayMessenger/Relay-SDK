/**
 * `relayapp mcp` — minimal MCP stdio server exposing one tool,
 * relay_send_message, so a Codex session (via [mcp_servers.relay]) can message
 * its owner over Relay mid-run. Hand-rolled JSON-RPC over newline-delimited
 * stdio; only the handshake + tools surface is implemented.
 */
import { createInterface } from "node:readline";
import { requireClient } from "./codex.js";

const TOOL = {
  name: "relay_send_message",
  description:
    "Send a text message to your owner over Relay (the paired messaging app). " +
    "Use for progress updates or questions that need a human.",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string", description: "Message text to send." },
    },
    required: ["text"],
  },
};

export async function mcpServe(): Promise<void> {
  const write = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

  for await (const line of rl) {
    if (line.trim().length === 0) continue;
    let request: any;
    try {
      request = JSON.parse(line);
    } catch {
      continue;
    }
    const { id, method, params } = request;
    const reply = (result: unknown) => {
      if (id !== undefined) write({ jsonrpc: "2.0", id, result });
    };
    const fail = (code: number, message: string) => {
      if (id !== undefined) write({ jsonrpc: "2.0", id, error: { code, message } });
    };
    try {
      switch (method) {
        case "initialize":
          reply({
            protocolVersion: params?.protocolVersion ?? "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "relayapp", version: "0.1.0-dev" },
          });
          break;
        case "notifications/initialized":
          break;
        case "tools/list":
          reply({ tools: [TOOL] });
          break;
        case "tools/call": {
          if (params?.name !== TOOL.name) {
            fail(-32602, `unknown tool: ${params?.name}`);
            break;
          }
          const text = String(params?.arguments?.text ?? "").trim();
          if (text.length === 0) {
            fail(-32602, "text is required");
            break;
          }
          const { client, conversationId } = requireClient();
          if (!conversationId) {
            reply({
              content: [{
                type: "text",
                text:
                  "No pinned owner conversation yet — run `relayapp start` once and have " +
                  "the owner message this agent first.",
              }],
              isError: true,
            });
            break;
          }
          await client.postMessage(
            { conversation_id: conversationId, parts: [{ type: "text", text: text.slice(0, 7900) }] },
            `relay-mcp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          );
          reply({ content: [{ type: "text", text: "Sent." }] });
          break;
        }
        case "ping":
          reply({});
          break;
        default:
          if (id !== undefined) fail(-32601, `method not implemented: ${method}`);
      }
    } catch (error: any) {
      fail(-32603, String(error?.message ?? error));
    }
  }
}
