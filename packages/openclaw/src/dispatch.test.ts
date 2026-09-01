import type {
  ChatHandle,
  Message,
  RelayWebhookEvent,
} from "@relaymessenger/sdk";
import { describe, expect, it, vi } from "vitest";
import {
  dispatchRelayEvent,
  resolveRelayTurnActivation,
} from "./dispatch.js";
import type {
  RelayInboundFacts,
  ResolvedRelayAccount,
} from "./types.js";

const ownerHandle: ChatHandle = {
  id: "00000000-0000-7000-8000-000000000001",
  handle: "relay",
  kind: "agent",
  is_me: true,
  joined_at: "2026-09-01T00:00:00.000Z",
  display_name: "Relay Agent",
  avatar_url: null,
  tagline: null,
  verified: false,
};

function facts(
  overrides: Partial<RelayInboundFacts> = {},
): RelayInboundFacts {
  return {
    eventId: "00000000-0000-7000-8000-000000000002",
    messageId: "00000000-0000-7000-8000-000000000003",
    chatId: "00000000-0000-7000-8000-000000000004",
    chatType: "group",
    contactId: "00000000-0000-7000-8000-000000000005",
    handle: "alice",
    displayName: "Alice",
    text: "Hello",
    mentionHandles: [],
    ownerHandle,
    ...overrides,
  };
}

function replyTarget(overrides: Partial<Message> = {}): Message {
  return {
    id: "00000000-0000-7000-8000-000000000006",
    chat_id: "00000000-0000-7000-8000-000000000004",
    is_system_message: false,
    is_from_me: true,
    delivery_status: "sent",
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function unmentionedGroupEvent(): RelayWebhookEvent {
  return {
    api_version: "v1",
    webhook_version: "2026-08-30",
    event_type: "message.received",
    event_id: "00000000-0000-7000-8000-000000000007",
    created_at: "2026-09-01T00:00:00.000Z",
    trace_id: "trace-unmentioned",
    agent_id: ownerHandle.id,
    data: {
      chat: {
        id: "00000000-0000-7000-8000-000000000004",
        is_group: true,
        owner_handle: ownerHandle,
      },
      id: "00000000-0000-7000-8000-000000000003",
      direction: "inbound",
      sender_handle: {
        id: "00000000-0000-7000-8000-000000000005",
        handle: "alice",
        kind: "user",
        joined_at: "2026-09-01T00:00:00.000Z",
        display_name: "Alice",
        avatar_url: null,
        tagline: null,
        verified: false,
      },
      parts: [
        {
          type: "text",
          value: "@relay visible text is not canonical metadata",
          reactions: null,
        },
      ],
      sent_at: "2026-09-01T00:00:00.000Z",
      reply_to: null,
    },
  };
}

describe("Relay turn activation", () => {
  it("routes direct Messages without requiring mention metadata", async () => {
    const retrieve = vi.fn();
    await expect(
      resolveRelayTurnActivation({
        facts: facts({
          chatType: "direct",
        }),
        relay: { messages: { retrieve } as never },
      }),
    ).resolves.toEqual({
      kind: "direct",
      wasMentioned: false,
      implicitMentionKinds: [],
    });
    expect(retrieve).not.toHaveBeenCalled();
  });

  it("routes group Messages with a canonical owner mention", async () => {
    const retrieve = vi.fn();
    await expect(
      resolveRelayTurnActivation({
        facts: facts({
          text: "visible text need not be parsed for @mentions",
          mentionHandles: ["relay"],
        }),
        relay: { messages: { retrieve } as never },
      }),
    ).resolves.toEqual({
      kind: "mention",
      wasMentioned: true,
      implicitMentionKinds: [],
    });
    expect(retrieve).not.toHaveBeenCalled();
  });

  it("routes group replies only when the referenced Message is from this agent", async () => {
    const retrieve = vi.fn(async () => replyTarget());
    await expect(
      resolveRelayTurnActivation({
        facts: facts({
          replyToId: "00000000-0000-7000-8000-000000000006",
        }),
        relay: { messages: { retrieve } as never },
      }),
    ).resolves.toEqual({
      kind: "reply",
      wasMentioned: false,
      implicitMentionKinds: ["reply_to_bot"],
    });
    expect(retrieve).toHaveBeenCalledWith(
      "00000000-0000-7000-8000-000000000006",
    );
  });

  it("does not invoke for unmentioned group traffic or replies to another user", async () => {
    const retrieve = vi.fn(async () =>
      replyTarget({ is_from_me: false }),
    );
    await expect(
      resolveRelayTurnActivation({
        facts: facts({
          text: "@relay visible text is not canonical metadata",
          mentionHandles: ["bob"],
        }),
        relay: { messages: { retrieve } as never },
      }),
    ).resolves.toBeNull();
    expect(retrieve).not.toHaveBeenCalled();

    await expect(
      resolveRelayTurnActivation({
        facts: facts({
          replyToId: "00000000-0000-7000-8000-000000000006",
        }),
        relay: { messages: { retrieve } as never },
      }),
    ).resolves.toBeNull();
    expect(retrieve).toHaveBeenCalledOnce();
  });

  it("returns before OpenClaw invocation for unmentioned group traffic", async () => {
    const dispatch = vi.fn();
    const markAsRead = vi.fn();
    const startTyping = vi.fn();
    const stopTyping = vi.fn();
    const warn = vi.fn();
    await dispatchRelayEvent({
      event: unmentionedGroupEvent(),
      lifecycle: {} as never,
      account: {
        accountId: "default",
        enabled: true,
        configured: true,
        token: "rly_test",
        baseUrl: "https://api.relayapp.im",
        allowFrom: [],
        config: {},
      } satisfies ResolvedRelayAccount,
      cfg: {},
      relay: {
        chats: { markAsRead, startTyping, stopTyping } as never,
        messages: { retrieve: vi.fn() } as never,
      },
      runtime: {
        channel: { inbound: { dispatch } },
      } as never,
      warn,
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(markAsRead).not.toHaveBeenCalled();
    expect(startTyping).not.toHaveBeenCalled();
    expect(stopTyping).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("unmentioned group Message"),
    );
  });
});
