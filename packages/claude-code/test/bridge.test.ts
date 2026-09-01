import type { ChatHandle, Message, RelayWebhookEvent } from "@relaymessenger/sdk";
import { describe, expect, it } from "vitest";
import {
  buildReply,
  classifyRelayEvent,
  deliveryFromSnapshotMessage,
} from "../src/bridge.ts";
import { parseAllowedSenders } from "../src/config.ts";
import { createRedactor } from "../src/redaction.ts";

const USER_ID = "00000000-0000-7000-8000-000000000001";
const CHAT_ID = "00000000-0000-7000-8000-000000000002";
const MESSAGE_ID = "00000000-0000-7000-8000-000000000003";
const EVENT_ID = "00000000-0000-7000-8000-000000000004";
const AGENT_ID = "00000000-0000-7000-8000-000000000005";

const sender: ChatHandle = {
  id: USER_ID,
  handle: "@owner",
  kind: "user",
  joined_at: "2026-09-01T00:00:00.000Z",
  display_name: "Owner",
  avatar_url: null,
  tagline: null,
  verified: false,
};

const agent: ChatHandle = {
  id: AGENT_ID,
  handle: "@relay-agent",
  kind: "agent",
  joined_at: "2026-09-01T00:00:00.000Z",
  is_me: true,
  display_name: "Relay Agent",
  avatar_url: null,
  tagline: null,
  verified: false,
};

function event(
  text = "ship the fix",
  from: ChatHandle = sender,
  options: {
    readonly group?: boolean;
    readonly mention?: string | null;
    readonly owner?: ChatHandle | null;
    readonly replyTo?: string | null;
  } = {},
): RelayWebhookEvent {
  return {
    api_version: "v1",
    webhook_version: "2026-08-30",
    event_type: "message.received",
    event_id: EVENT_ID,
    created_at: "2026-09-01T00:00:01.000Z",
    trace_id: "trace-1",
    agent_id: AGENT_ID,
    data: {
      chat: {
        id: CHAT_ID,
        is_group: options.group ?? false,
        owner_handle: options.owner === undefined
          ? options.group ? agent : null
          : options.owner,
      },
      id: MESSAGE_ID,
      idempotency_key: null,
      direction: "inbound",
      sender_handle: from,
      parts: [{
        type: "text",
        value: text,
        reactions: null,
        ...(options.mention === undefined ? {} : { mention: options.mention }),
      }],
      sent_at: "2026-09-01T00:00:01.000Z",
      delivered_at: null,
      read_at: null,
      reply_to: options.replyTo ? { message_id: options.replyTo } : null,
    },
  };
}

const redactor = createRedactor("rly_secret_abcdefghijklmnop");

describe("Relay v1 Message mapping", () => {
  it("maps an allowlisted message to current claude/channel string metadata", () => {
    const action = classifyRelayEvent({
      event: event(),
      sequence: "7",
      allowedSenders: parseAllowedSenders(USER_ID),
      redactor,
    });
    expect(action.kind).toBe("delivery");
    if (action.kind !== "delivery") return;
    expect(action.delivery.content).toBe("ship the fix");
    expect(action.delivery.meta).toEqual({
      chat_id: CHAT_ID,
      message_id: MESSAGE_ID,
      sender_id: USER_ID,
      sender_handle: "@owner",
      delivery_id: EVENT_ID,
      source_sequence: "7",
      sent_at: "2026-09-01T00:00:01.000Z",
    });
  });

  it("gates sender identity before content interpretation", () => {
    const stranger = { ...sender, id: "00000000-0000-7000-8000-000000000099", handle: "@stranger" };
    const action = classifyRelayEvent({
      event: event("yes abcde", stranger),
      sequence: "1",
      allowedSenders: parseAllowedSenders(USER_ID),
      redactor,
    });
    expect(action.kind).toBe("blocked");
  });

  it("classifies direct, canonical mention, reply, and unaddressed group traffic", () => {
    const classify = (input: RelayWebhookEvent) => classifyRelayEvent({
      event: input,
      sequence: "1",
      allowedSenders: parseAllowedSenders(USER_ID),
      redactor,
    });
    const direct = classify(event());
    const mentioned = classify(event("@relay-agent take this", sender, {
      group: true,
      mention: "@RELAY-AGENT",
    }));
    const reply = classify(event("following up", sender, {
      group: true,
      replyTo: "00000000-0000-7000-8000-000000000099",
    }));
    const plainText = classify(event("@relay-agent take this", sender, { group: true }));
    const otherMention = classify(event("@someone-else take this", sender, {
      group: true,
      mention: "@someone-else",
    }));
    const wrongOwner = classify(event("@relay-agent forged owner", sender, {
      group: true,
      mention: "@relay-agent",
      owner: { ...agent, id: "00000000-0000-7000-8000-000000000099" },
    }));
    expect(direct.kind === "delivery" && direct.groupGate).toBe("direct");
    expect(mentioned.kind === "delivery" && mentioned.groupGate).toBe("mention");
    expect(reply.kind === "delivery" && reply.groupGate).toBe("reply");
    expect(plainText.kind === "delivery" && plainText.groupGate).toBe("unaddressed");
    expect(otherMention.kind === "delivery" && otherMention.groupGate).toBe("unaddressed");
    expect(wrongOwner.kind === "delivery" && wrongOwner.groupGate).toBe("unaddressed");
  });

  it("uses only Relay REST Message content with one idempotency key", () => {
    expect(buildReply("done", "claude-reply-key", MESSAGE_ID)).toEqual({
      message: {
        parts: [{ type: "text", value: "done" }],
        idempotency_key: "claude-reply-key",
        reply_to: { message_id: MESSAGE_ID },
      },
    });
  });
});

describe("FULL sync reconciliation", () => {
  it("stages only unread allowlisted inbound Messages", () => {
    const message: Message = {
      id: MESSAGE_ID,
      chat_id: CHAT_ID,
      from: "@owner",
      from_handle: sender,
      parts: [{ type: "text", value: "missed while offline", reactions: null }],
      reply_to: null,
      is_system_message: false,
      system_event: null,
      is_from_me: false,
      delivery_status: "delivered",
      created_at: "2026-09-01T00:00:00.000Z",
      updated_at: "2026-09-01T00:00:00.000Z",
      sent_at: "2026-09-01T00:00:00.000Z",
      delivered_at: "2026-09-01T00:00:00.000Z",
      read_at: null,
      deliveries: [{
        contact: agent,
        delivered_at: "2026-09-01T00:00:00.000Z",
        read_at: null,
      }],
    };
    const delivery = deliveryFromSnapshotMessage({
      message,
      chat: {
        id: CHAT_ID,
        display_name: null,
        handles: [sender, agent],
        is_group: false,
        created_at: "2026-09-01T00:00:00.000Z",
        updated_at: "2026-09-01T00:00:00.000Z",
      },
      agentMessageIds: new Set(),
      throughSequence: "42",
      allowedSenders: parseAllowedSenders(USER_ID),
      redactor,
    });
    expect(delivery?.deliveryId).toBe(`fullsync-${MESSAGE_ID}`);
    expect(delivery?.meta.full_sync).toBe("true");
    expect(deliveryFromSnapshotMessage({
      message: {
        ...message,
        read_at: null,
        deliveries: [{
          contact: agent,
          delivered_at: "2026-09-01T00:00:00.000Z",
          read_at: "2026-09-01T00:00:02.000Z",
        }],
      },
      chat: {
        id: CHAT_ID,
        display_name: null,
        handles: [sender, agent],
        is_group: false,
        created_at: "2026-09-01T00:00:00.000Z",
        updated_at: "2026-09-01T00:00:00.000Z",
      },
      agentMessageIds: new Set(),
      throughSequence: "42",
      allowedSenders: parseAllowedSenders(USER_ID),
      redactor,
    })).toBeNull();
  });

  it("safely refuses an unread Message whose sender cannot be authenticated", () => {
    const message = {
      id: MESSAGE_ID,
      chat_id: CHAT_ID,
      from_handle: null,
      parts: [{ type: "text", value: "unknown", reactions: null }],
      is_system_message: false,
      is_from_me: false,
      delivery_status: "delivered",
      created_at: "2026-09-01T00:00:00.000Z",
      updated_at: "2026-09-01T00:00:00.000Z",
      read_at: null,
      deliveries: [{
        contact: agent,
        delivered_at: "2026-09-01T00:00:00.000Z",
        read_at: null,
      }],
    } as Message;
    expect(() => deliveryFromSnapshotMessage({
      message,
      chat: {
        id: CHAT_ID,
        display_name: null,
        handles: [sender, agent],
        is_group: false,
        created_at: "2026-09-01T00:00:00.000Z",
        updated_at: "2026-09-01T00:00:00.000Z",
      },
      agentMessageIds: new Set(),
      throughSequence: "42",
      allowedSenders: parseAllowedSenders(USER_ID),
      redactor,
    })).toThrow(/cannot authenticate unread inbound Message/u);
  });

  it("uses only this Agent's delivery row and never aggregate read_at", () => {
    const other = {
      ...sender,
      id: "00000000-0000-7000-8000-000000000099",
      handle: "@other",
    };
    const base: Message = {
      id: MESSAGE_ID,
      chat_id: CHAT_ID,
      from: "@owner",
      from_handle: sender,
      parts: [{ type: "text", value: "per-agent receipt", reactions: null }],
      reply_to: null,
      is_system_message: false,
      system_event: null,
      is_from_me: false,
      delivery_status: "read",
      created_at: "2026-09-01T00:00:00.000Z",
      updated_at: "2026-09-01T00:00:00.000Z",
      delivered_at: "2026-09-01T00:00:00.000Z",
      read_at: "2026-09-01T00:00:05.000Z",
      deliveries: [
        {
          contact: other,
          delivered_at: "2026-09-01T00:00:00.000Z",
          read_at: "2026-09-01T00:00:05.000Z",
        },
        {
          contact: agent,
          delivered_at: "2026-09-01T00:00:00.000Z",
          read_at: null,
        },
      ],
    };
    const chat = {
      id: CHAT_ID,
      display_name: null,
      handles: [sender, other, agent],
      is_group: false,
      created_at: "2026-09-01T00:00:00.000Z",
      updated_at: "2026-09-01T00:00:00.000Z",
    };
    expect(deliveryFromSnapshotMessage({
      message: base,
      chat,
      agentMessageIds: new Set(),
      throughSequence: "42",
      allowedSenders: parseAllowedSenders(USER_ID),
      redactor,
    })?.messageId).toBe(MESSAGE_ID);
    expect(deliveryFromSnapshotMessage({
      message: {
        ...base,
        read_at: null,
        deliveries: base.deliveries!.map((row) =>
          row.contact.is_me
            ? { ...row, read_at: "2026-09-01T00:00:06.000Z" }
            : { ...row, read_at: null }),
      },
      chat,
      agentMessageIds: new Set(),
      throughSequence: "42",
      allowedSenders: parseAllowedSenders(USER_ID),
      redactor,
    })).toBeNull();
    expect(() => deliveryFromSnapshotMessage({
      message: { ...base, deliveries: [] },
      chat,
      agentMessageIds: new Set(),
      throughSequence: "42",
      allowedSenders: parseAllowedSenders(USER_ID),
      redactor,
    })).toThrow(/deliveries\[\]\.contact\.is_me/u);
    expect(() => deliveryFromSnapshotMessage({
      message: {
        ...base,
        deliveries: [base.deliveries![1]!, base.deliveries![1]!],
      },
      chat,
      agentMessageIds: new Set(),
      throughSequence: "42",
      allowedSenders: parseAllowedSenders(USER_ID),
      redactor,
    })).toThrow(/expected one deliveries\[\]\.contact\.is_me row/u);
  });
});
