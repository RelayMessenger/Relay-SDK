import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type {
  ChatHandle,
  Message,
  MessageSendParams,
  Relay,
  RelayWebhookEvent,
} from "@relaymessenger/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { RelayChannel } from "../src/channel.ts";
import type { RelayChannelConfig } from "../src/config.ts";
import { parseAllowedSenders } from "../src/config.ts";
import { createRedactor } from "../src/redaction.ts";
import { RelayStateStore } from "../src/state.ts";

const TOKEN = "rly_test_abcdefghijklmnop";
const AGENT_ID = "00000000-0000-7000-8000-000000000900";
const CHAT_A = "00000000-0000-7000-8000-000000000101";
const CHAT_B = "00000000-0000-7000-8000-000000000102";
const USER_A = "00000000-0000-7000-8000-000000000201";
const USER_B = "00000000-0000-7000-8000-000000000202";
const cleanups: string[] = [];

afterEach(() => {
  for (const path of cleanups.splice(0)) rmSync(path, { recursive: true, force: true });
});

function uuid(value: number): string {
  return `00000000-0000-7000-8000-${String(value).padStart(12, "0")}`;
}

const agent: ChatHandle = {
  id: AGENT_ID,
  handle: "@relay-agent",
  kind: "agent",
  joined_at: "2026-09-01T00:00:00.000Z",
  is_me: true,
  display_name: "Relay Agent",
  image_url: null,
  tagline: null,
  verified: false,
};
const senderA: ChatHandle = {
  id: USER_A,
  handle: "@owner-a",
  kind: "user",
  joined_at: "2026-09-01T00:00:00.000Z",
  display_name: "Owner A",
  image_url: null,
  tagline: null,
  verified: false,
};
const senderB: ChatHandle = {
  ...senderA,
  id: USER_B,
  handle: "@owner-b",
  display_name: "Owner B",
};

function event(params: {
  readonly sequence: number;
  readonly text: string;
  readonly chatId?: string;
  readonly sender?: ChatHandle;
  readonly group?: boolean;
  readonly mention?: string;
  readonly replyTo?: string;
}): RelayWebhookEvent {
  const eventId = uuid(300 + params.sequence);
  const messageId = uuid(400 + params.sequence);
  return {
    api_version: "v1",
    webhook_version: "2026-08-30",
    event_type: "message.received",
    event_id: eventId,
    created_at: `2026-09-01T00:00:${String(params.sequence).padStart(2, "0")}.000Z`,
    trace_id: `trace-${params.sequence}`,
    agent_id: AGENT_ID,
    data: {
      chat: {
        id: params.chatId ?? CHAT_A,
        is_group: params.group ?? false,
        owner_handle: params.group ? agent : null,
      },
      id: messageId,
      idempotency_key: null,
      direction: "inbound",
      sender_handle: params.sender ?? senderA,
      parts: [{
        type: "text",
        value: params.text,
        reactions: null,
        ...(params.mention ? { mention: params.mention } : {}),
      }],
      sent_at: `2026-09-01T00:00:${String(params.sequence).padStart(2, "0")}.000Z`,
      delivered_at: null,
      read_at: null,
      reply_to: params.replyTo ? { message_id: params.replyTo } : null,
    },
  };
}

interface FakeRelay {
  readonly relay: Relay;
  readonly reads: string[];
  readonly sends: Array<{ chatId: string; body: MessageSendParams }>;
  readonly retrieved: string[];
  readonly agentMessages: Map<string, Message>;
}

function fakeRelay(): FakeRelay {
  const reads: string[] = [];
  const sends: Array<{ chatId: string; body: MessageSendParams }> = [];
  const retrieved: string[] = [];
  const agentMessages = new Map<string, Message>();
  const relay = {
    chats: {
      markAsRead: async (chatId: string) => {
        reads.push(chatId);
      },
      messages: {
        send: async (chatId: string, body: MessageSendParams) => {
          sends.push({ chatId, body });
          return {
            chat_id: chatId,
            message: {
              id: uuid(800 + sends.length),
              parts: [],
              created_at: "2026-09-01T00:01:00.000Z",
              sent_at: "2026-09-01T00:01:00.000Z",
              delivery_status: "sent",
              is_system_message: false,
            },
          };
        },
      },
    },
    messages: {
      retrieve: async (messageId: string) => {
        retrieved.push(messageId);
        const found = agentMessages.get(messageId);
        if (!found) throw new Error(`unknown fake Message ${messageId}`);
        return found;
      },
    },
  } as unknown as Relay;
  return { relay, reads, sends, retrieved, agentMessages };
}

function fixture() {
  const stateDir = mkdtempSync(join(tmpdir(), "relay-channel-test-"));
  cleanups.push(stateDir);
  const state = new RelayStateStore({ stateDir, sessionKey: "session" });
  const notifications: Array<{ method: string; params?: unknown }> = [];
  const mcp = {
    notification: async (notification: { method: string; params?: unknown }) => {
      notifications.push(notification);
    },
  } as unknown as Server;
  const fake = fakeRelay();
  const config: RelayChannelConfig = {
    agentToken: TOKEN,
    baseURL: "http://127.0.0.1:8790",
    allowedSenders: parseAllowedSenders(`${USER_A},${USER_B}`),
    channelDir: stateDir,
    stateDir,
    accountKey: "account",
    sessionKey: "session",
    notificationRetryMs: 60_000,
  };
  const logs: string[] = [];
  const channel = new RelayChannel({
    mcp,
    state,
    config,
    redactor: createRedactor(TOKEN),
    log: (message) => logs.push(message),
    relay: fake.relay,
  });
  return { state, notifications, fake, channel, logs, mcp, config };
}

function accept(state: RelayStateStore, input: RelayWebhookEvent, sequence: number): void {
  state.acceptEvent(input, String(sequence));
}

describe("multi-user turn isolation", () => {
  it("keeps replies on the active Chat and treats approval-like text as ordinary content", async () => {
    const { state, notifications, fake, channel } = fixture();
    try {
      const originA = event({ sequence: 1, text: "task A" });
      accept(state, originA, 1);
      await channel.flush();
      await channel.beginProcessing({ delivery_id: originA.event_id });
      const crossChatReply = await channel.reply({
        chat_id: CHAT_B,
        text: "must not cross Chats",
        send_id: "cross-chat",
      });
      expect(crossChatReply.isError).toBe(true);
      const originB = event({
        sequence: 2,
        text: "yes abcde",
        chatId: CHAT_B,
        sender: senderB,
      });
      accept(state, originB, 2);
      await channel.flush();
      expect(notifications.map((item) => item.method)).toEqual([
        "notifications/claude/channel",
        "notifications/claude/channel",
      ]);
      expect((notifications[1]?.params as { content: string }).content).toBe("yes abcde");
      await channel.beginProcessing({ delivery_id: originB.event_id });
      const staleA = await channel.reply({
        chat_id: CHAT_A,
        text: "must not return to A",
        send_id: "stale-a",
      });
      expect(staleA.isError).toBe(true);
      const sentB = await channel.reply({
        chat_id: CHAT_B,
        text: "B complete",
        send_id: "turn-b",
      });
      expect(sentB.isError).not.toBe(true);
      expect(fake.sends.map((send) => send.chatId)).toEqual([CHAT_B]);
    } finally {
      state.close();
    }
  });

  it("clears reply origins on explicit failure and process replacement", async () => {
    const { state, fake, channel, mcp, config } = fixture();
    try {
      const originA = event({ sequence: 1, text: "turn A fails" });
      accept(state, originA, 1);
      await channel.flush();
      await channel.beginProcessing({ delivery_id: originA.event_id });
      const failed = await channel.completeProcessing({
        delivery_id: originA.event_id,
        outcome: "failed",
      });
      expect(failed.isError).not.toBe(true);
      expect(state.activeTurnOrigin()).toBeNull();
      expect((await channel.reply({
        chat_id: CHAT_A,
        text: "blocked after failure",
        send_id: "after-failure",
      })).isError).toBe(true);
      const originB = event({
        sequence: 2,
        text: "turn B interrupted by restart",
        chatId: CHAT_B,
        sender: senderB,
      });
      accept(state, originB, 2);
      await channel.flush();
      await channel.beginProcessing({ delivery_id: originB.event_id });
      const replacement = new RelayChannel({
        mcp,
        state,
        config,
        redactor: createRedactor(TOKEN),
        log: () => undefined,
        relay: fake.relay,
      });
      expect(state.activeTurnOrigin()).toBeNull();
      expect((await replacement.reply({
        chat_id: CHAT_B,
        text: "blocked after restart",
        send_id: "after-restart",
      })).isError).toBe(true);
      expect(fake.sends).toHaveLength(0);
    } finally {
      state.close();
    }
  });
});

describe("live group addressing", () => {
  it("creates turns only for canonical mentions or verified replies to this Agent", async () => {
    const { state, notifications, fake, channel } = fixture();
    try {
      const parentId = uuid(700);
      fake.agentMessages.set(parentId, {
        id: parentId,
        chat_id: CHAT_A,
        from: agent.handle,
        from_handle: agent,
        parts: [{ type: "text", value: "agent parent", reactions: null }],
        reply_to: null,
        is_system_message: false,
        system_event: null,
        is_from_me: true,
        delivery_status: "delivered",
        created_at: "2026-09-01T00:00:00.000Z",
        updated_at: "2026-09-01T00:00:00.000Z",
      });
      const otherParentId = uuid(701);
      fake.agentMessages.set(otherParentId, {
        ...fake.agentMessages.get(parentId)!,
        id: otherParentId,
        is_from_me: false,
        from: senderB.handle,
        from_handle: senderB,
      });
      const candidates = [
        event({ sequence: 1, text: "@relay-agent plain text", group: true }),
        event({
          sequence: 2,
          text: "@relay-agent structured",
          group: true,
          mention: "@RELAY-AGENT",
        }),
        event({ sequence: 3, text: "reply to agent", group: true, replyTo: parentId }),
        event({
          sequence: 4,
          text: "reply to user",
          group: true,
          replyTo: otherParentId,
        }),
        event({
          sequence: 5,
          text: "@other structured",
          group: true,
          mention: "@other",
        }),
      ];
      for (const [index, candidate] of candidates.entries()) {
        accept(state, candidate, index + 1);
      }
      await channel.flush();
      const turns = notifications.filter((item) =>
        item.method === "notifications/claude/channel");
      expect(turns).toHaveLength(2);
      expect(turns.map((turn) =>
        (turn.params as { content: string }).content)).toEqual([
        "@relay-agent structured",
        "reply to agent",
      ]);
      expect(fake.retrieved).toEqual([parentId, otherParentId]);
    } finally {
      state.close();
    }
  });
});
