/**
 * `relaymessenger mcp` — minimal MCP stdio server exposing one tool,
 * relay_send_message, so a Codex session (via [mcp_servers.relay]) can message
 * its owner over Relay mid-run. Hand-rolled JSON-RPC over newline-delimited
 * stdio; only the handshake + tools surface is implemented.
 */
import { createInterface } from "node:readline";
import { requireClient } from "./codex.js";
import { McpSendLedger } from "./store.js";

const TOOL = {
  name: "relay_send_message",
  description:
    "Send a text message to your owner over Relay (the paired messaging app). " +
    "Use for progress updates or questions that need a human.",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string", description: "Message text to send." },
      send_id: {
        type: "string",
        description:
          "Required stable logical-operation id. Reuse it only to retry the exact same message after an unknown outcome.",
      },
    },
    required: ["text", "send_id"],
  },
};

/** The one MCP revision this deliberately small server implements. */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

export function negotiateMcpProtocolVersion(_requested: unknown): string {
  return MCP_PROTOCOL_VERSION;
}

export interface McpSendDependencies {
  requireContext?: typeof requireClient;
}

export async function sendMcpMessage(
  input: { text?: unknown; send_id?: unknown },
  dependencies: McpSendDependencies = {},
): Promise<{ sent: boolean; message: string }> {
  const text = typeof input.text === "string" ? input.text.trim() : "";
  if (text.length === 0) throw new Error("text is required");
  if (text.length > 7_900) throw new Error("text must be at most 7900 characters");
  const sendId = typeof input.send_id === "string" ? input.send_id.trim() : "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(sendId)) {
    throw new Error("send_id is required and must be 1-200 stable identifier characters");
  }

  const context = (dependencies.requireContext ?? requireClient)();
  if (!context.conversationId) {
    return {
      sent: false,
      message:
        "No pinned owner conversation yet; run `relaymessenger start` once and have " +
        "the owner message this agent first.",
    };
  }
  const ledger = new McpSendLedger(
    context.runtimeHome,
    context.apiOrigin,
    context.accountIdentity,
  );
  const logicalSend = ledger.register(sendId, context.conversationId, text);
  await context.client.postMessage(
    { conversation_id: context.conversationId, parts: [{ type: "text", text }] },
    logicalSend.idempotency_key,
  );
  ledger.confirm(logicalSend);
  return { sent: true, message: "Sent." };
}

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
            protocolVersion: negotiateMcpProtocolVersion(params?.protocolVersion),
            capabilities: { tools: {} },
            serverInfo: { name: "relaymessenger", version: "0.1.0" },
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
          let result: Awaited<ReturnType<typeof sendMcpMessage>>;
          try {
            result = await sendMcpMessage(params?.arguments ?? {});
          } catch (error: any) {
            fail(-32602, String(error?.message ?? error));
            break;
          }
          if (!result.sent) {
            reply({
              content: [{ type: "text", text: result.message }],
              isError: true,
            });
            break;
          }
          reply({ content: [{ type: "text", text: result.message }] });
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
