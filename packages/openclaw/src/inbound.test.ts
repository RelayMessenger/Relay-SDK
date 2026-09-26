import type {
  ChatHandle,
  MessagePartResponse,
  RelayWebhookEvent,
} from "@relaymessenger/sdk";
import { describe, expect, it } from "vitest";
import type { RelayMessageReceivedEvent } from "./types.js";
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
  image_url: null,
  subtitle: null,
  verified: false,
  is_contact: true,
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
          image_url: null,
          subtitle: null,
          verified: false,
          is_contact: true,
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
        image_url: null,
        subtitle: null,
        verified: false,
        is_contact: true,
      },
      replyToId: "00000000-0000-7000-8000-000000000006",
      replyAnchorId: "00000000-0000-7000-8000-000000000005",
      fromAgent: false,
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

  it("reads a tap as the text it is and anchors the answer to the tap, not the buttons", () => {
    const base = event();
    const data = base.data as RelayMessageReceivedEvent["data"];
    const input = {
      ...base,
      data: {
        ...data,
        parts: [{ type: "text", value: "Yes, 7pm works", reactions: null }],
        reply_to: { message_id: "00000000-0000-7000-8000-000000000006", part_index: 1 },
      },
    } as RelayWebhookEvent;
    const facts = buildRelayInboundFacts(input);
    expect(facts?.text).toBe("Yes, 7pm works");
    expect(facts?.replyToId).toBe("00000000-0000-7000-8000-000000000006");
    expect(facts?.replyAnchorId).toBe("00000000-0000-7000-8000-000000000005");
    expect(renderRelayMessageParts([
      { type: "buttons", items: [{ label: "Yes" }], reactions: null },
    ])).toBe("");
  });

  it("maps agent-authored Messages for the same downstream authorization and activation", () => {
    const agentSender = { ...sender, kind: "agent" as const };
    const input = event();
    (input.data as { sender_handle: ChatHandle }).sender_handle = agentSender;
    const { replyAnchorId: _personAnchor, ...personFacts } = buildRelayInboundFacts(event())!;
    expect(buildRelayInboundFacts(input)).toEqual({
      ...personFacts,
      fromAgent: true,
      agentReplyLink: "00000000-0000-7000-8000-000000000005",
    });
  });

  it("names another agent's own Message as the answer's target, never a person's", () => {
    // Relay's A2A door gives a calling agent only the answer whose reply_to
    // names its Message (Relay-Server a2a.ts replyTo; CLI bridges, PR 366).
    const input = event();
    const data = input.data as RelayMessageReceivedEvent["data"];
    data.sender_handle = { ...sender, kind: "agent" };
    data.reply_to = null;
    expect(buildRelayInboundFacts(input)).toMatchObject({
      fromAgent: true,
      agentReplyLink: "00000000-0000-7000-8000-000000000005",
    });
    data.sender_handle = sender;
    const person = buildRelayInboundFacts(input);
    expect(person?.fromAgent).toBe(false);
    expect(person).not.toHaveProperty("agentReplyLink");
  });

  it("does not name another agent's Message that opens with buttons or a selection", () => {
    // An agent may not reply to those parts, and a reply names part 0.
    for (const opening of [
      { type: "buttons", items: [{ label: "Yes" }], reactions: null },
      { type: "selection", title: "Pick", options: [{ value: "a", label: "A" }], reactions: null },
    ]) {
      const input = event();
      const data = input.data as RelayMessageReceivedEvent["data"];
      data.sender_handle = { ...sender, kind: "agent" };
      data.parts = [opening, { type: "text", value: "Which one?", mention: "relay", reactions: null }] as never;
      const facts = buildRelayInboundFacts(input);
      expect(facts?.fromAgent).toBe(true);
      expect(facts).not.toHaveProperty("agentReplyLink");
    }
  });

  it("does not map outbound/self echoes from either Contact kind", () => {
    for (const kind of ["user", "agent"] as const) {
      const input = event();
      const data = input.data as { direction: string; sender_handle: ChatHandle };
      data.direction = "outbound";
      data.sender_handle = { ...sender, kind, is_me: true };
      expect(buildRelayInboundFacts(input)).toBeNull();
    }
  });

  it("rejects unknown sender kinds instead of granting them agent behavior", () => {
    const input = event();
    (input.data as { sender_handle: { kind: string } }).sender_handle = {
      ...sender,
      kind: "unknown",
    };
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

it("retains stable selection values and explicit source separately from visible text", () => {
  const input = event();
  if (input.event_type !== "message.received") throw new Error("fixture");
  input.data.parts = [
    { type: "text", value: "• Research\n• Design", reactions: null },
    { type: "selection_response", selected_values: ["research", "design"] },
  ];
  input.data.reply_to = { message_id: "source", part_index: 1 };
  const facts = buildRelayInboundFacts(input);
  expect(facts?.text).toBe("• Research\n• Design");
  expect(facts?.selection).toEqual({ selected_values: ["research", "design"], reply_to: { message_id: "source", part_index: 1 } });
  expect(renderRelayMessageParts([input.data.parts[1]!])).toBe("");
});

it("keeps full component context, including another agent's component-only message", () => {
  const input = event() as RelayMessageReceivedEvent;
  input.data.parts = [{ type: "buttons", items: [{ label: "Do not execute this label" }], reactions: null }];
  const facts = buildRelayInboundFacts(input);
  expect(facts?.text).toBe("");
  expect(facts?.richMessage).toEqual({ parts: input.data.parts, reply_to: input.data.reply_to });
});
