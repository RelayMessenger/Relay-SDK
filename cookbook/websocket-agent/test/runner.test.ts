import type {
  Chat,
  Message,
  RelayWebhookEvent,
  WebSocketFullSyncContext,
} from "@relaymessenger/sdk";
import { describe, expect, it, vi } from "vitest";

import { createSocketCallbacks } from "../src/runner.js";

function page<T>(values: T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      yield* values;
    },
  };
}

const CHAT = {
  id: "01993d50-ef7b-7b37-886b-23fd80c7ec12",
  display_name: null,
  handles: [],
  is_group: false,
  created_at: "2026-09-01T12:00:00Z",
  updated_at: "2026-09-01T12:00:00Z",
} satisfies Chat;

const MESSAGE = {
  id: "01993d50-ef7b-7b37-886b-23fd80c7ec13",
  chat_id: CHAT.id,
  is_system_message: false,
  is_from_me: false,
  delivery_status: "delivered",
  created_at: "2026-09-01T12:00:00Z",
  updated_at: "2026-09-01T12:00:00Z",
} satisfies Message;

const EVENT = {
  api_version: "v1",
  webhook_version: "2026-08-30",
  event_type: "message.received",
  event_id: "01993d50-ef7b-7b37-886b-23fd80c7ec10",
  created_at: "2026-09-01T12:00:00Z",
  trace_id: "trace",
  agent_id: "01993d50-ef7b-7b37-886b-23fd80c7ec11",
  data: {
    chat: { id: CHAT.id },
    id: MESSAGE.id,
    direction: "inbound",
    sender_handle: {
      id: "01993d50-ef7b-7b37-886b-23fd80c7ec14",
      handle: "sender",
      kind: "user",
      joined_at: "2026-09-01T12:00:00Z",
      display_name: null,
      image_url: null,
      about: null,
      verified: false,
    },
    parts: [],
  },
} satisfies RelayWebhookEvent;

describe("acknowledged WebSocket boundaries", () => {
  it("returns from onEvent only after the durable insert", async () => {
    const timeline: string[] = [];
    const callbacks = createSocketCallbacks({
      chats: {
        listChats: async () => page([]),
        messages: { list: async () => page([]) },
      },
    }, {
      accept: () => {
        timeline.push("committed");
        return true;
      },
      replaceSnapshot: vi.fn(),
    }, () => timeline.push("worker-woken"));

    await callbacks.onEvent(EVENT, { sequence: "42" });
    timeline.push("callback-resolved");

    expect(timeline).toEqual([
      "committed",
      "worker-woken",
      "callback-resolved",
    ]);
  });

  it("loads every Chat and Message before committing FULL sync", async () => {
    const timeline: string[] = [];
    const replaceSnapshot = vi.fn((
      snapshot: { chats: Chat[]; messages: Message[] },
      context: WebSocketFullSyncContext,
    ) => {
      timeline.push("snapshot-committed");
      expect(snapshot).toEqual({
        chats: [CHAT],
        messages: [MESSAGE],
      });
      expect(context).toEqual({
        throughSequence: "91",
        reason: "checkpoint_outside_retention",
      });
    });
    const callbacks = createSocketCallbacks({
      chats: {
        listChats: async () => {
          timeline.push("chats-loaded");
          return page([CHAT]);
        },
        messages: {
          list: async () => {
            timeline.push("messages-loaded");
            return page([MESSAGE]);
          },
        },
      },
    }, {
      accept: vi.fn(),
      replaceSnapshot,
    }, vi.fn());

    await callbacks.onFullSync({
      throughSequence: "91",
      reason: "checkpoint_outside_retention",
    });
    timeline.push("callback-resolved");

    expect(timeline).toEqual([
      "chats-loaded",
      "messages-loaded",
      "snapshot-committed",
      "callback-resolved",
    ]);
  });

  it("refuses a cross-Chat FULL-sync Message before committing", async () => {
    const replaceSnapshot = vi.fn();
    const callbacks = createSocketCallbacks({
      chats: {
        listChats: async () => page([CHAT]),
        messages: {
          list: async () => page([{
            ...MESSAGE,
            chat_id: "01993d50-ef7b-7b37-886b-23fd80c7ec99",
          }]),
        },
      },
    }, {
      accept: vi.fn(),
      replaceSnapshot,
    }, vi.fn());

    await expect(callbacks.onFullSync({
      throughSequence: "91",
      reason: "checkpoint_outside_retention",
    })).rejects.toThrow(/belongs to/);
    expect(replaceSnapshot).not.toHaveBeenCalled();
  });
});
