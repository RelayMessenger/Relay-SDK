import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Chat, ChatHandle, Message, Relay, RelayWebhookEvent } from "@relaymessenger/sdk";
import { describe, expect, it } from "vitest";
import { classifyRelayEvent, deliveryFromSnapshotMessage } from "../src/bridge.ts";
import { RelayChannel } from "../src/channel.ts";
import { parseAllowedSenders, senderIsAllowed } from "../src/config.ts";
import { commitRelayFullSync, reconcileFullSyncDeliveries } from "../src/fullSync.ts";
import { createRedactor } from "../src/redaction.ts";
import { RelayStateStore } from "../src/state.ts";

const id = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const now = "2026-09-08T00:00:00.000Z";
const contact = (n: number, kind: "user" | "agent"): ChatHandle => ({
  id: id(n), handle: `contact-${n}`, kind, joined_at: now,
  display_name: `Contact ${n}`, image_url: null, about: null, verified: false,
});
const receiver = { ...contact(900, "agent"), is_me: true };
const peer = contact(901, "agent");
const denied = contact(902, "agent");
const allowed = parseAllowedSenders(peer.id);
const redactor = createRedactor("synthetic-unused-token");
const chat = (n = 100, group = false): Chat => ({
  id: id(n), handles: [receiver, peer], is_group: group, display_name: null,
  created_at: now, updated_at: now,
});
const message = (n: number, overrides: Partial<Message> = {}): Message => ({
  id: id(n), chat_id: id(100), from: peer.handle, from_handle: peer,
  parts: [{ type: "text", value: `message ${n}`, reactions: null }],
  is_from_me: false, is_system_message: false, delivery_status: "delivered",
  created_at: now, updated_at: now, sent_at: now, read_at: null,
  deliveries: [{ contact: receiver, delivered_at: now, read_at: null }],
  ...overrides,
});
const event = (n: number, sender = peer, group = false, overrides: Partial<Message> = {}): RelayWebhookEvent => {
  const msg = message(n, overrides);
  return {
    api_version: "v1", webhook_version: "2026-08-30",
    event_type: "message.received", event_id: id(n + 1000), created_at: now,
    trace_id: `agent-regression-${n}`, agent_id: receiver.id,
    data: {
      chat: { id: msg.chat_id, is_group: group, owner_handle: receiver },
      id: msg.id, direction: "inbound", sender_handle: sender,
      parts: msg.parts!, sent_at: now, reply_to: msg.reply_to ?? null,
    },
  } as RelayWebhookEvent;
};
const classify = (input: RelayWebhookEvent) => classifyRelayEvent({
  event: input, sequence: "1", allowedSenders: allowed, redactor,
});
const reconcile = (input: Message) => deliveryFromSnapshotMessage({
  message: input, chat: chat(), agentMessageIds: new Set(),
  throughSequence: "42", allowedSenders: allowed, redactor,
});
const page = <T>(items: T[]): AsyncIterable<T> => ({
  async *[Symbol.asyncIterator]() { yield* items; },
});

describe("authorized agent Contact admission", () => {
  it.each(["user", "agent"] as const)("uses the same exact allowlist for %s senders", (kind) => {
    const sender = { ...peer, kind };
    expect(senderIsAllowed(allowed, sender)).toBe(true);
    expect(senderIsAllowed(parseAllowedSenders(peer.handle), sender)).toBe(true);
    expect(senderIsAllowed(parseAllowedSenders(peer.handle.toUpperCase()), sender)).toBe(false);
    expect(classify(event(1, sender)).kind).toBe("delivery");
    expect(reconcile(message(1, { from_handle: sender }))?.messageId).toBe(id(1));
  });

  it("keeps non-allowlisted agents denied in intake and FULL sync", () => {
    expect(classify(event(1, denied)).kind).toBe("blocked");
    expect(reconcile(message(1, { from_handle: denied }))).toBeNull();
  });

  it("keeps unknown kinds fail-closed even with an allowed ID and Handle", () => {
    const unknown = { ...peer, kind: "unknown" } as unknown as ChatHandle;
    expect(senderIsAllowed(allowed, unknown)).toBe(false);
    expect(classify(event(1, unknown)).kind).toBe("blocked");
    expect(() => reconcile(message(1, { from_handle: unknown })))
      .toThrow(/cannot authenticate unread inbound Message/u);
  });

  it("does not elevate agent sender kind over inbound/self/system checks", () => {
    const outbound = event(1);
    (outbound.data as { direction: string }).direction = "outbound";
    expect(classify(outbound).kind).toBe("refuse");
    expect(reconcile(message(1, { is_from_me: true }))).toBeNull();
    expect(reconcile(message(1, { is_system_message: true }))).toBeNull();
  });

  it("retains per-receiver Read checks for an authorized agent's offline Message", () => {
    expect(reconcile(message(1, { read_at: now }))?.messageId).toBe(id(1));
    expect(reconcile(message(1, {
      deliveries: [{ contact: receiver, delivered_at: now, read_at: now }],
    }))).toBeNull();
    expect(() => reconcile(message(1, { deliveries: [] }))).toThrow(/deliveries/u);
  });

  it("durably commits and deduplicates an authorized agent FULL-sync delivery", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-agent-fullsync-"));
    const state = new RelayStateStore({ stateDir: dir, sessionKey: "session" });
    const relay = { chats: {
      listChats: async () => page([chat()]),
      messages: { list: async () => page([message(1)]) },
    } } as unknown as Relay;
    try {
      for (let i = 0; i < 2; i++) {
        await commitRelayFullSync({
          relay, state, context: { throughSequence: "42", reason: "checkpoint_outside_retention" },
          allowedSenders: allowed, redactor,
        });
      }
      expect(state.acceptedThrough()).toBe("42");
      expect(state.pendingDeliveries(Number.MAX_SAFE_INTEGER).map(row => row.messageId)).toEqual([id(1)]);
      expect(state.readSnapshot()?.chats[0]?.messages[0]?.from_handle?.kind).toBe("agent");
    } finally {
      state.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves group mention/reply gates and cross-Chat isolation in FULL sync", () => {
    const group = chat(101, true);
    const parent = message(10, { chat_id: group.id, is_from_me: true, from_handle: receiver });
    const otherChatParent = message(11, { is_from_me: true, from_handle: receiver });
    const grouped = (n: number, overrides: Partial<Message> = {}) => message(n, { chat_id: group.id, ...overrides });
    const deliveries = reconcileFullSyncDeliveries({
      snapshot: { version: 1, throughSequence: "42", reason: "checkpoint_outside_retention", completedAt: now, chats: [
        { chat: chat(), messages: [otherChatParent, message(1)] },
        { chat: group, messages: [
          parent,
          grouped(2, { parts: [{ type: "text", value: "canonical", mention: receiver.handle, reactions: null }] }),
          grouped(3, { reply_to: { message_id: parent.id } }),
          grouped(4, { parts: [{ type: "text", value: `@${receiver.handle} visible only`, reactions: null }] }),
          grouped(5, { reply_to: { message_id: otherChatParent.id } }),
          grouped(6, { parts: [{ type: "text", value: "wrong mention", mention: "someone-else", reactions: null }] }),
          grouped(7, { from_handle: denied, parts: [{ type: "text", value: "denied", mention: receiver.handle, reactions: null }] }),
        ] },
      ] },
      allowedSenders: allowed, redactor,
    });
    expect(deliveries.map(row => row.messageId)).toEqual([id(1), id(2), id(3)]);
  });

  it("retains live durable admission, canonical group gates and active-Chat reply authority", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-agent-channel-"));
    const state = new RelayStateStore({ stateDir: dir, sessionKey: "session" });
    const notifications: unknown[] = [];
    const sends: string[] = [];
    const reads: string[] = [];
    const relay = {
      chats: {
        markAsRead: async (chatId: string) => { reads.push(chatId); },
        messages: { send: async (chatId: string) => { sends.push(chatId); return { chat_id: chatId, message: message(99) }; } },
      },
      messages: { retrieve: async (messageId: string) => message(Number(messageId.slice(-12)), {
        chat_id: messageId === id(10) ? id(101) : id(100), is_from_me: true, from_handle: receiver,
      }) },
    } as unknown as Relay;
    const channel = new RelayChannel({
      state, relay, redactor, log: () => undefined,
      mcp: { notification: async (value: unknown) => { notifications.push(value); } } as unknown as Server,
      config: {
        agentToken: "synthetic-unused-token", baseURL: "http://127.0.0.1:8790", allowedSenders: allowed,
        channelDir: dir, stateDir: dir, accountKey: "account", sessionKey: "session", notificationRetryMs: 60_000,
      },
    });
    try {
      const direct = event(1);
      const cases = [
        direct,
        event(2, denied),
        event(3, peer, true, { chat_id: id(101) }),
        event(4, peer, true, { chat_id: id(101), parts: [{ type: "text", value: "canonical", mention: receiver.handle, reactions: null }] }),
        event(5, peer, true, { chat_id: id(101), reply_to: { message_id: id(10) } }),
        event(6, peer, true, { chat_id: id(101), reply_to: { message_id: id(11) } }),
      ];
      for (const [index, input] of cases.entries()) state.acceptEvent(input, String(index + 1));
      state.acceptEvent(direct, "1");
      await channel.flush();
      expect(notifications).toHaveLength(3);
      expect(reads).toEqual([]);
      expect(state.acceptedThrough()).toBe("6");
      expect((await channel.beginProcessing({ delivery_id: direct.event_id })).isError).not.toBe(true);
      expect((await channel.reply({ chat_id: id(101), text: "cross-chat", send_id: "wrong-chat" })).isError).toBe(true);
      expect((await channel.reply({ chat_id: id(100), text: "wrong parent", send_id: "wrong-parent", reply_to_message_id: id(99) })).isError).toBe(true);
      expect((await channel.reply({ chat_id: id(100), text: "agent reply", send_id: "one-reply" })).isError).not.toBe(true);
      expect((await channel.reply({ chat_id: id(100), text: "agent reply", send_id: "one-reply" })).isError).not.toBe(true);
      expect(sends).toEqual([id(100)]);
      expect(reads).toEqual([id(100)]);
    } finally {
      channel.stop();
      state.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
