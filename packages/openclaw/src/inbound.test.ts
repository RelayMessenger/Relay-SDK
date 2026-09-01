import type {
  ChatHandle,
  MessagePartResponse,
  RelayWebhookEvent,
} from "@relaymessenger/sdk";
import { describe, expect, it } from "vitest";
import {
  buildRelayInboundFacts,
  renderRelayMessageParts,
} from "./inbound.js";

const sender: ChatHandle = {
  id: "00000000-0000-7000-8000-000000000002",
  handle: "alice",
  kind: "user",
  joined_at: "2026-09-01T00:00:00.000Z",
  display_name: "Alice",
  avatar_url: null,
  tagline: null,
  verified: false,
};

function event(
  overrides: Partial<RelayWebhookEvent> = {},
): RelayWebhookEvent {
  return {
    api_version: "v1",
    webhook_version: "2026-08-30",
    event_type: "message.received",
    event_id: "00000000-0000-7000-8000-000000000001",
    created_at: "2026-09-01T00:00:02.000Z",
    trace_id: "trace-1",
    agent_id: "00000000-0000-7000-8000-000000000003",
    data: {
      chat: {
        id: "00000000-0000-7000-8000-000000000004",
        is_group: true,
        owner_handle: {
          id: "00000000-0000-7000-8000-000000000003",
          handle: "relay",
          kind: "agent",
          is_me: true,
          joined_at: "2026-09-01T00:00:00.000Z",
          display_name: "Relay Agent",
          avatar_url: null,
          tagline: null,
          verified: false,
        },
      },
      id: "00000000-0000-7000-8000-000000000005",
      direction: "inbound",
      sender_handle: sender,
      parts: [
        {
          type: "text",
          value: "Hello",
          mention: "relay",
          mention_range: [0, 5],
          reactions: null,
        },
      ],
      sent_at: "2026-09-01T00:00:01.000Z",
      reply_to: {
        message_id: "00000000-0000-7000-8000-000000000006",
        part_index: 0,
      },
    },
    ...overrides,
  } as RelayWebhookEvent;
}

describe("Relay inbound Message mapping", () => {
  it("maps Contact, Handle, Chat, and Message facts", () => {
    expect(buildRelayInboundFacts(event())).toEqual({
      eventId: "00000000-0000-7000-8000-000000000001",
      messageId: "00000000-0000-7000-8000-000000000005",
      chatId: "00000000-0000-7000-8000-000000000004",
      chatType: "group",
      contactId: "00000000-0000-7000-8000-000000000002",
      handle: "alice",
      displayName: "Alice",
      text: "Hello",
      mentionHandles: ["relay"],
      ownerHandle: {
        id: "00000000-0000-7000-8000-000000000003",
        handle: "relay",
        kind: "agent",
        is_me: true,
        joined_at: "2026-09-01T00:00:00.000Z",
        display_name: "Relay Agent",
        avatar_url: null,
        tagline: null,
        verified: false,
      },
      replyToId: "00000000-0000-7000-8000-000000000006",
      timestamp: Date.parse("2026-09-01T00:00:01.000Z"),
    });
  });

  it("renders only current Relay Message part vocabulary", () => {
    const parts: MessagePartResponse[] = [
      { type: "text", value: "Read this", reactions: null },
      { type: "link", value: "https://example.test", reactions: null },
      {
        type: "media",
        id: "attachment-1",
        url: "https://cdn.example.test/file",
        filename: "report.pdf",
        mime_type: "application/pdf",
        size_bytes: 42,
        reactions: null,
      },
    ];
    expect(renderRelayMessageParts(parts)).toBe(
      "Read this\nhttps://example.test\n" +
        "[Attachment: report.pdf (application/pdf)] https://cdn.example.test/file",
    );
  });

  it("accepts transport events but does not start turns for agent-authored Messages", () => {
    const agentSender = { ...sender, kind: "agent" as const };
    const input = event();
    (input.data as { sender_handle: ChatHandle }).sender_handle = agentSender;
    expect(buildRelayInboundFacts(input)).toBeNull();
  });

  it("ignores non-received events and empty Messages", () => {
    expect(
      buildRelayInboundFacts(
        event({ event_type: "message.delivered" } as Partial<RelayWebhookEvent>),
      ),
    ).toBeNull();
    const input = event();
    (input.data as { parts: MessagePartResponse[] }).parts = [];
    expect(buildRelayInboundFacts(input)).toBeNull();
  });
});
