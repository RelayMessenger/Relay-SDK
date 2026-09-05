import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type Relay from "@relaymessenger/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRelayMcpServer } from "./server.js";

const CHAT_ID = "01993d50-754d-7f51-a51b-5da552024fd1";
const MESSAGE_ID = "01993d50-4133-7178-8e16-7c1455c91d43";

const fakeRelay = () => {
  const calls = {
    listChats: vi.fn(async () => ({
      chats: [{ id: CHAT_ID }],
      nextCursor: null,
    })),
    send: vi.fn(async () => ({
      chat_id: CHAT_ID,
      message: { id: MESSAGE_ID },
    })),
    react: vi.fn(async () => ({ status: "accepted" })),
    requestContact: vi.fn(async () => ({ state: "pending" })),
    shareCard: vi.fn(async () => undefined),
    sendToUser: vi.fn(async () => ({ chat_id: CHAT_ID })),
  };
  const client = {
    chats: {
      listChats: calls.listChats,
      messages: { send: calls.send },
      shareContactCard: calls.shareCard,
    },
    messages: { addReaction: calls.react, create: calls.sendToUser },
    contactRequests: { create: calls.requestContact },
  } as unknown as Relay;
  return { client, calls };
};

const sessions: Array<{ client: Client; server: ReturnType<typeof createRelayMcpServer> }> = [];

const connect = async (relay: Relay, secrets: string[] = []) => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createRelayMcpServer({
    resolveClient: async () => ({ client: relay, secrets }),
    collectSecrets: async () => secrets,
  });
  const client = new Client({ name: "relay-mcp-unit", version: "1.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  sessions.push({ client, server });
  return client;
};

afterEach(async () => {
  await Promise.all(
    sessions.splice(0).map(async ({ client, server }) => {
      await client.close().catch(() => {});
      await server.close().catch(() => {});
    }),
  );
});

describe("explicit Relay MCP tools", () => {
  it("lists the complete explicit surface without auth arguments", async () => {
    const fake = fakeRelay();
    const client = await connect(fake.client);
    const tools = (await client.listTools()).tools;
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "relay_create_contact_request",
      "relay_get_chat",
      "relay_get_contact_card",
      "relay_get_message",
      "relay_get_message_thread",
      "relay_list_chats",
      "relay_list_messages",
      "relay_mark_chat_read",
      "relay_react_to_message",
      "relay_send_message",
      "relay_send_message_to_chat",
      "relay_set_contact_card",
      "relay_share_contact_card",
      "relay_start_typing",
      "relay_stop_typing",
      "relay_update_contact_card",
    ]);
    expect(JSON.stringify(tools).toLowerCase()).not.toContain("agent_token");
    expect(JSON.stringify(tools).toLowerCase()).not.toContain("authorization");
  });

  it("routes reads and idempotent sends through SDK methods", async () => {
    const fake = fakeRelay();
    const client = await connect(fake.client);
    const listed = await client.callTool({
      name: "relay_list_chats",
      arguments: { limit: 20 },
    });
    expect(listed.isError).not.toBe(true);
    expect(fake.calls.listChats).toHaveBeenCalledWith({ limit: 20 });

    const sent = await client.callTool({
      name: "relay_send_message_to_chat",
      arguments: {
        chat_id: CHAT_ID,
        text: "Hello",
        idempotency_key: "logical-send-1",
      },
    });
    expect(sent.isError).not.toBe(true);
    expect(fake.calls.send).toHaveBeenCalledWith(CHAT_ID, {
      message: {
        parts: [{ type: "text", value: "Hello" }],
        idempotency_key: "logical-send-1",
      },
    });
  });

  it("rejects invalid inputs before Relay mutations", async () => {
    const fake = fakeRelay();
    const client = await connect(fake.client);
    const result = await client.callTool({
      name: "relay_react_to_message",
      arguments: {
        message_id: MESSAGE_ID,
        operation: "add",
        type: "custom",
      },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toMatch(/invalid/i);
    expect(fake.calls.react).not.toHaveBeenCalled();
  });

  it("preserves agent card sharing, add requests, and Messages to an eligible user", async () => {
    const fake = fakeRelay();
    const client = await connect(fake.client);
    const shared = await client.callTool({
      name: "relay_share_contact_card",
      arguments: { chat_id: CHAT_ID },
    });
    expect(shared.isError).not.toBe(true);
    expect(fake.calls.shareCard).toHaveBeenCalledWith(CHAT_ID);

    const requested = await client.callTool({
      name: "relay_create_contact_request",
      arguments: { handle: "advait" },
    });
    expect(requested.isError).not.toBe(true);
    expect(fake.calls.requestContact).toHaveBeenCalledWith({ handle: "advait" });

    const sent = await client.callTool({
      name: "relay_send_message",
      arguments: { recipients: ["advait"], text: "Hello", idempotency_key: "agent-send-1" },
    });
    expect(sent.isError).not.toBe(true);
    expect(fake.calls.sendToUser).toHaveBeenCalledWith({
      to: ["advait"],
      message: {
        parts: [{ type: "text", value: "Hello" }],
        idempotency_key: "agent-send-1",
      },
    });
  });

  it("describes Contacts eligibility without a separate approval tool", async () => {
    const client = await connect(fakeRelay().client);
    const tools = (await client.listTools()).tools;
    for (const name of ["relay_send_message", "relay_send_message_to_chat"]) {
      const tool = tools.find((entry) => entry.name === name)!;
      expect(tool.description).toContain("every agent must be that user's added Contact and not blocked");
      expect(tool.description).toContain("Agent-only messaging keeps its existing behavior");
    }
    expect(tools.find((entry) => entry.name === "relay_send_message")!.description)
      .toContain("Agents and users have the same generic Chat API permissions");
    expect(tools.find((entry) => entry.name === "relay_create_contact_request")!.description)
      .toContain("A pending Add request does not grant messaging eligibility");
    expect(tools.some((entry) => /approval|mutual|policy/i.test(entry.name))).toBe(false);
  });

  it("preserves agent-only messaging without Contact-request preflights", async () => {
    const fake = fakeRelay();
    const client = await connect(fake.client);
    const recipients = ["research.agent", "planner.agent"];
    const result = await client.callTool({
      name: "relay_send_message",
      arguments: { recipients, text: "Hello agents", idempotency_key: "agent-only-1" },
    });
    expect(result.isError).not.toBe(true);
    expect(fake.calls.sendToUser).toHaveBeenCalledWith({
      to: recipients,
      message: {
        parts: [{ type: "text", value: "Hello agents" }],
        idempotency_key: "agent-only-1",
      },
    });
    expect(fake.calls.requestContact).not.toHaveBeenCalled();
  });

  it("redacts Agent Tokens from tool failures", async () => {
    const token = "rly_tool_secret_012345";
    const fake = fakeRelay();
    fake.calls.listChats.mockRejectedValueOnce(
      new Error(`upstream echoed ${token}`),
    );
    const client = await connect(fake.client, [token]);
    const result = await client.callTool({
      name: "relay_list_chats",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain(token);
    expect(JSON.stringify(result)).toContain("[REDACTED]");
  });
});
