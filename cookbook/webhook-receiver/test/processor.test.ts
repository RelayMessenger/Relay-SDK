import { describe, expect, it, vi } from "vitest";
import type {
  MessageWebhookData,
  RelayWebhookEnvelope,
} from "@relaymessenger/sdk";

import {
  processAcceptedEvent,
  shouldReply,
} from "../src/processor.js";

const EVENT: RelayWebhookEnvelope<
  MessageWebhookData,
  "message.received"
> = {
  api_version: "v1",
  webhook_version: "2026-08-30",
  event_type: "message.received",
  event_id: "01993d50-ef7b-7b37-886b-23fd80c7ec10",
  created_at: "2026-09-01T12:00:00Z",
  trace_id: "trace",
  agent_id: "01993d50-ef7b-7b37-886b-23fd80c7ec11",
  data: {
    chat: {
      id: "01993d50-ef7b-7b37-886b-23fd80c7ec12",
      is_group: false,
    },
    id: "01993d50-ef7b-7b37-886b-23fd80c7ec13",
    direction: "inbound",
    sender_handle: {
      id: "01993d50-ef7b-7b37-886b-23fd80c7ec14",
      handle: "sender",
      kind: "user",
      joined_at: "2026-09-01T12:00:00Z",
      display_name: null,
      image_url: null,
      tagline: null,
      verified: false,
    },
    parts: [
      {
        type: "text",
        value: "one two",
        reactions: null,
      },
      {
        type: "media",
        id: "01993d50-ef7b-7b37-886b-23fd80c7ec15",
        url: "https://media.example.test/file",
        filename: "file.txt",
        mime_type: "text/plain",
        size_bytes: 3,
        reactions: null,
      },
    ],
  },
};

describe("accepted event processing", () => {
  it("sends one idempotent Message through the SDK boundary", async () => {
    const send = vi.fn().mockResolvedValue({});

    await processAcceptedEvent({
      chats: { messages: { send } },
    }, EVENT);

    expect(send).toHaveBeenCalledWith(EVENT.data.chat.id, {
      message: {
        parts: [{
          type: "text",
          value: "2 words, 7 characters, 1 attachment",
        }],
        idempotency_key: `relay-example:webhook:${EVENT.event_id}`,
      },
    });
  });

  it("ignores unmentioned group traffic and accepts the canonical owner mention", () => {
    const owner = {
      ...EVENT.data.sender_handle,
      id: EVENT.agent_id,
      handle: "metrics",
      kind: "agent" as const,
      is_me: true,
    };
    const group = {
      ...EVENT.data,
      chat: {
        id: EVENT.data.chat.id,
        is_group: true,
        owner_handle: owner,
      },
      parts: [{ type: "text" as const, value: "hello", reactions: null }],
    };
    expect(shouldReply(group)).toBe(false);
    expect(shouldReply({
      ...group,
      parts: [{
        type: "text",
        value: "@metrics hello",
        mention: "metrics",
        mention_range: [0, 8],
        reactions: null,
      }],
    })).toBe(true);
  });
});
