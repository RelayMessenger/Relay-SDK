import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
  about: null,
  verified: false,
};
const senderA: ChatHandle = {
  id: USER_A,
  handle: "@owner-a",
  kind: "user",
  joined_at: "2026-09-01T00:00:00.000Z",
  display_name: "Owner A",
  image_url: null,
  about: null,
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

describe("unanswered deliveries survive supersession and expiry", () => {
  it("re-notifies a superseded delivery and lets it open a fresh turn", async () => {
    const { state, notifications, fake, channel } = fixture();
    try {
      const first = event({ sequence: 1, text: "first question" });
      const second = event({ sequence: 2, text: "second question", chatId: CHAT_B, sender: senderB });
      accept(state, first, 1);
      accept(state, second, 2);
      await channel.flush();
      expect(notifications).toHaveLength(2);
      await channel.beginProcessing({ delivery_id: first.event_id });
      // The model starts the second before answering the first.
      await channel.beginProcessing({ delivery_id: second.event_id });
      expect(state.activeTurnOrigin()).toMatchObject({ deliveryId: second.event_id });
      expect(state.delivery(first.event_id)).toMatchObject({ status: "pending" });
      // While turn 2 is active the requeued first delivery stays quiet, or it
      // could supersede turn 2 and the two would ping-pong forever.
      await channel.flush();
      await channel.flush();
      expect(notifications).toHaveLength(2);
      expect((await channel.reply({
        chat_id: CHAT_B,
        text: "answer two",
        send_id: "two",
      })).isError).not.toBe(true);
      expect(state.activeTurnOrigin()).toBeNull();
      // First flush after turn 2 closed: the first delivery is notified again.
      await channel.flush();
      expect(notifications).toHaveLength(3);
      expect((notifications[2]?.params as { content: string }).content).toBe("first question");
      // Re-notification is idempotent inside the retry window.
      await channel.flush();
      expect(notifications).toHaveLength(3);
      const reopened = await channel.beginProcessing({ delivery_id: first.event_id });
      expect(reopened.isError).not.toBe(true);
      expect(reopened.content[0]?.text).toContain("processing started");
      expect(fake.reads).toEqual([CHAT_A, CHAT_B, CHAT_A]);
      expect((await channel.reply({
        chat_id: CHAT_A,
        text: "answer one",
        send_id: "one",
      })).isError).not.toBe(true);
      expect(fake.sends.map((send) => send.chatId)).toEqual([CHAT_B, CHAT_A]);
      // Both answered: nothing re-notifies and neither reopens.
      await channel.flush();
      expect(notifications).toHaveLength(3);
      expect((await channel.beginProcessing({ delivery_id: first.event_id })).isError).toBe(true);
      expect((await channel.beginProcessing({ delivery_id: second.event_id })).isError).toBe(true);
    } finally {
      state.close();
    }
  });

  it("keeps a replied delivery closed when a later turn is superseded", async () => {
    const { state, notifications, fake, channel } = fixture();
    try {
      const first = event({ sequence: 1, text: "answered" });
      const second = event({ sequence: 2, text: "left open", chatId: CHAT_B, sender: senderB });
      const third = event({ sequence: 3, text: "newest" });
      accept(state, first, 1);
      await channel.flush();
      await channel.beginProcessing({ delivery_id: first.event_id });
      expect((await channel.reply({ chat_id: CHAT_A, text: "done", send_id: "one" })).isError)
        .not.toBe(true);
      accept(state, second, 2);
      accept(state, third, 3);
      await channel.flush();
      await channel.beginProcessing({ delivery_id: second.event_id });
      await channel.beginProcessing({ delivery_id: third.event_id });
      await channel.flush();
      const before = notifications.map((item) => (item.params as { content: string }).content);
      expect(before).toEqual(["answered", "left open", "newest"]);
      expect((await channel.completeProcessing({
        delivery_id: third.event_id,
        outcome: "completed",
      })).isError).not.toBe(true);
      await channel.flush();
      const after = notifications.map((item) => (item.params as { content: string }).content);
      expect(after).toEqual(["answered", "left open", "newest", "left open"]);
      // The answered first delivery never comes back; the requeued second can.
      expect((await channel.beginProcessing({ delivery_id: first.event_id })).isError).toBe(true);
      expect((await channel.beginProcessing({ delivery_id: second.event_id })).isError)
        .not.toBe(true);
      expect(fake.sends).toHaveLength(1);
    } finally {
      state.close();
    }
  });

  it("holds a superseded delivery until the active turn closes, then notifies it", async () => {
    const { state, notifications, channel } = fixture();
    try {
      const first = event({ sequence: 1, text: "held" });
      const second = event({ sequence: 2, text: "current", chatId: CHAT_B, sender: senderB });
      const third = event({ sequence: 3, text: "brand new" });
      accept(state, first, 1);
      accept(state, second, 2);
      await channel.flush();
      await channel.beginProcessing({ delivery_id: first.event_id });
      await channel.beginProcessing({ delivery_id: second.event_id });
      expect(state.delivery(first.event_id)).toMatchObject({ status: "pending" });
      // A never-turned delivery still notifies at once while turn 2 runs.
      accept(state, third, 3);
      await channel.flush();
      expect(notifications.map((item) => (item.params as { content: string }).content))
        .toEqual(["held", "current", "brand new"]);
      expect((await channel.completeProcessing({
        delivery_id: second.event_id,
        outcome: "completed",
      })).isError).not.toBe(true);
      await channel.flush();
      expect(notifications.map((item) => (item.params as { content: string }).content))
        .toEqual(["held", "current", "brand new", "held"]);
      const reopened = await channel.beginProcessing({ delivery_id: first.event_id });
      expect(reopened.isError).not.toBe(true);
      expect(reopened.content[0]?.text).toContain("processing started");
      expect(state.activeTurnOrigin()).toMatchObject({ deliveryId: first.event_id });
    } finally {
      state.close();
    }
  });

  it("repairs deliveries stranded at processing by a pre-fix supersession on open", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "relay-channel-stranded-"));
    cleanups.push(stateDir);
    const stranded = event({ sequence: 1, text: "stranded before the fix" });
    const answered = event({ sequence: 2, text: "answered before the fix", chatId: CHAT_B, sender: senderB });
    {
      // Build the pre-fix shape directly: processing rows with closed-turn
      // markers and no lease, exactly what an old install carries on disk.
      const seed = new RelayStateStore({ stateDir, sessionKey: "session" });
      accept(seed, stranded, 1);
      accept(seed, answered, 2);
      seed.close();
      const db = new DatabaseSync(join(stateDir, "channel.sqlite"));
      for (const [input, outcome] of [[stranded, "superseded"], [answered, "completed"]] as const) {
        const data = input.data as { chat: { id: string }; id: string; sender_handle: ChatHandle };
        db.prepare(`
          INSERT INTO deliveries(
            delivery_id, event_id, message_id, chat_id, sender_id, sender_handle,
            content, meta_json, created_at, status, last_notified_at,
            processing_started_at, read_marked_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'processing', 5, 6, 7)
        `).run(
          input.event_id,
          input.event_id,
          data.id,
          data.chat.id,
          data.sender_handle.id,
          data.sender_handle.handle,
          (input.data as { parts: Array<{ value: string }> }).parts[0]?.value ?? "",
          JSON.stringify({ chat_id: data.chat.id, delivery_id: input.event_id }),
          input.created_at,
        );
        db.prepare("UPDATE transport_events SET status = 'delivery' WHERE event_id = ?")
          .run(input.event_id);
        db.prepare("INSERT INTO metadata(key, value) VALUES (?, ?)").run(
          `closed_turn:session:${input.event_id}`,
          JSON.stringify({ version: 1, outcome, closedAt: 8 }),
        );
      }
      db.close();
    }
    const state = new RelayStateStore({ stateDir, sessionKey: "session" });
    const notifications: Array<{ method: string; params?: unknown }> = [];
    const fake = fakeRelay();
    const channel = new RelayChannel({
      mcp: {
        notification: async (notification: { method: string; params?: unknown }) => {
          notifications.push(notification);
        },
      } as unknown as Server,
      state,
      config: {
        agentToken: TOKEN,
        baseURL: "http://127.0.0.1:8790",
        allowedSenders: parseAllowedSenders(`${USER_A},${USER_B}`),
        channelDir: stateDir,
        stateDir,
        accountKey: "account",
        sessionKey: "session",
        notificationRetryMs: 60_000,
      },
      redactor: createRedactor(TOKEN),
      log: () => undefined,
      relay: fake.relay,
    });
    try {
      expect(state.delivery(stranded.event_id)).toMatchObject({ status: "pending", lastNotifiedAt: null });
      expect(state.delivery(answered.event_id)).toMatchObject({ status: "processing", lastNotifiedAt: 5 });
      await channel.flush();
      expect(notifications.map((item) => (item.params as { content: string }).content))
        .toEqual(["stranded before the fix"]);
      const reopened = await channel.beginProcessing({ delivery_id: stranded.event_id });
      expect(reopened.isError).not.toBe(true);
      expect(state.activeTurnOrigin()).toMatchObject({ deliveryId: stranded.event_id });
      expect((await channel.beginProcessing({ delivery_id: answered.event_id })).isError).toBe(true);
      expect(state.delivery(answered.event_id)).toMatchObject({ status: "processing" });
    } finally {
      state.close();
    }
  });

  it("re-notifies a delivery whose turn expired before any reply", async () => {
    const { state, notifications, channel } = fixture();
    try {
      const first = event({ sequence: 1, text: "slow one" });
      accept(state, first, 1);
      await channel.flush();
      expect(notifications).toHaveLength(1);
      // Open the turn with a lease that is already in the past.
      state.beginDelivery(first.event_id, 10);
      state.markDeliveryProcessing(first.event_id, 11, 1);
      await channel.flush();
      expect(notifications).toHaveLength(2);
      expect((notifications[1]?.params as { content: string }).content).toBe("slow one");
      const reopened = await channel.beginProcessing({ delivery_id: first.event_id });
      expect(reopened.isError).not.toBe(true);
      expect((await channel.reply({ chat_id: CHAT_A, text: "late answer", send_id: "late" })).isError)
        .not.toBe(true);
      await channel.flush();
      expect(notifications).toHaveLength(2);
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
