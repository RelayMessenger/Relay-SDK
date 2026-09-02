import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Chat, Message, Relay } from "@relaymessenger/sdk";
import { describe, expect, it } from "vitest";
import { parseAllowedSenders } from "../src/config.ts";
import {
  commitRelayFullSync,
  readCompleteRelaySnapshot,
  reconcileFullSyncDeliveries,
} from "../src/fullSync.ts";
import { createRedactor } from "../src/redaction.ts";
import { RelayStateStore } from "../src/state.ts";

const USER_ID = "00000000-0000-7000-8000-000000000001";
const CHAT_ID = "00000000-0000-7000-8000-000000000002";
const MESSAGE_ID = "00000000-0000-7000-8000-000000000003";
const AGENT_ID = "00000000-0000-7000-8000-000000000005";
const sender = {
  id: USER_ID,
  handle: "@owner",
  kind: "user" as const,
  joined_at: "2026-09-01T00:00:00.000Z",
  display_name: "Owner",
  image_url: null,
  about: null,
  verified: false,
};
const agent = {
  id: AGENT_ID,
  handle: "@relay-agent",
  kind: "agent" as const,
  joined_at: "2026-09-01T00:00:00.000Z",
  is_me: true,
  display_name: "Relay Agent",
  image_url: null,
  about: null,
  verified: false,
};
const chat: Chat = {
  id: CHAT_ID,
  display_name: null,
  group_chat_icon: null,
  handles: [sender, agent],
  is_group: false,
  created_at: "2026-09-01T00:00:00.000Z",
  updated_at: "2026-09-01T00:00:00.000Z",
};
const message: Message = {
  id: MESSAGE_ID,
  chat_id: CHAT_ID,
  from: "@owner",
  from_handle: sender,
  parts: [{ type: "text", value: "offline message", reactions: null }],
  reply_to: null,
  is_system_message: false,
  system_event: null,
  is_from_me: false,
  delivery_status: "delivered",
  created_at: "2026-09-01T00:00:01.000Z",
  updated_at: "2026-09-01T00:00:01.000Z",
  sent_at: "2026-09-01T00:00:01.000Z",
  delivered_at: "2026-09-01T00:00:01.000Z",
  read_at: null,
  deliveries: [{
    contact: agent,
    delivered_at: "2026-09-01T00:00:01.000Z",
    read_at: null,
  }],
};

function asyncPage<T>(values: T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      yield* values;
    },
  };
}

function fakeRelay(): Pick<Relay, "chats"> {
  return {
    chats: {
      listChats: async () => asyncPage([chat]),
      messages: {
        list: async () => asyncPage([message]),
      },
    },
  } as unknown as Pick<Relay, "chats">;
}

describe("complete Relay REST FULL sync", () => {
  it("pages every Chat and Message before returning a snapshot", async () => {
    const snapshot = await readCompleteRelaySnapshot({
      relay: fakeRelay(),
      context: { throughSequence: "42", reason: "checkpoint_outside_retention" },
    });
    expect(snapshot.throughSequence).toBe("42");
    expect(snapshot.chats).toEqual([{ chat, messages: [message] }]);
  });

  it("durably applies the snapshot and unread allowed Message before completion", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-full-sync-"));
    const state = new RelayStateStore({ stateDir: dir, sessionKey: "session" });
    try {
      await commitRelayFullSync({
        relay: fakeRelay(),
        state,
        context: { throughSequence: "42", reason: "checkpoint_outside_retention" },
        allowedSenders: parseAllowedSenders(USER_ID),
        redactor: createRedactor("rly_secret_abcdefghijklmnop"),
      });
      expect(state.acceptedThrough()).toBe("42");
      expect(state.readSnapshot()?.chats[0]?.messages[0]?.id).toBe(MESSAGE_ID);
      expect(state.pendingDeliveries(Number.MAX_SAFE_INTEGER)[0]?.messageId).toBe(MESSAGE_ID);
    } finally {
      state.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reconciles direct, canonical mention, and reply-to-Agent but not unmentioned group traffic", () => {
    const groupChat: Chat = {
      ...chat,
      id: "00000000-0000-7000-8000-000000000012",
      is_group: true,
    };
    const groupMessage = (
      id: string,
      value: string,
      options: {
        readonly mention?: string;
        readonly replyTo?: string;
        readonly ownReadAt?: string | null;
        readonly aggregateReadAt?: string | null;
        readonly fromMe?: boolean;
      } = {},
    ): Message => ({
      ...message,
      id,
      chat_id: groupChat.id,
      from: options.fromMe ? agent.handle : sender.handle,
      from_handle: options.fromMe ? agent : sender,
      is_from_me: options.fromMe ?? false,
      parts: [{
        type: "text",
        value,
        reactions: null,
        ...(options.mention ? { mention: options.mention } : {}),
      }],
      reply_to: options.replyTo ? { message_id: options.replyTo } : null,
      read_at: options.aggregateReadAt ?? null,
      deliveries: [{
        contact: agent,
        delivered_at: "2026-09-01T00:00:01.000Z",
        read_at: options.ownReadAt ?? null,
      }],
    });
    const parentId = "00000000-0000-7000-8000-000000000020";
    const mentionedId = "00000000-0000-7000-8000-000000000021";
    const replyId = "00000000-0000-7000-8000-000000000022";
    const unmentionedId = "00000000-0000-7000-8000-000000000023";
    const wrongMentionId = "00000000-0000-7000-8000-000000000024";
    const readMentionId = "00000000-0000-7000-8000-000000000025";
    const aggregateReadId = "00000000-0000-7000-8000-000000000026";
    const deliveries = reconcileFullSyncDeliveries({
      snapshot: {
        version: 1,
        throughSequence: "42",
        reason: "checkpoint_outside_retention",
        completedAt: "2026-09-01T00:00:00.000Z",
        chats: [
          { chat, messages: [message] },
          {
            chat: groupChat,
            messages: [
              groupMessage(parentId, "agent parent", { fromMe: true }),
              groupMessage(mentionedId, "@relay-agent mentioned", {
                mention: "@RELAY-AGENT",
              }),
              groupMessage(replyId, "valid reply", { replyTo: parentId }),
              groupMessage(unmentionedId, "@relay-agent plain text"),
              groupMessage(wrongMentionId, "@other mentioned", { mention: "@other" }),
              groupMessage(readMentionId, "@relay-agent already read", {
                mention: "@relay-agent",
                ownReadAt: "2026-09-01T00:00:05.000Z",
              }),
              groupMessage(aggregateReadId, "@relay-agent aggregate says read", {
                mention: "@relay-agent",
                aggregateReadAt: "2026-09-01T00:00:05.000Z",
                ownReadAt: null,
              }),
            ],
          },
        ],
      },
      allowedSenders: parseAllowedSenders(USER_ID),
      redactor: createRedactor("rly_secret_abcdefghijklmnop"),
    });
    expect(deliveries.map((delivery) => delivery.messageId).sort()).toEqual([
      MESSAGE_ID,
      aggregateReadId,
      mentionedId,
      replyId,
    ].sort());
  });
});
