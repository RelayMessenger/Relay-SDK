import { describe, expect, it } from "vitest";
import {
  buildRelayInboundFacts,
  classifyRelayEvent,
  isRelayEchoMessage,
  renderRelayPartsText,
} from "./inbound.js";
import type { RelayEvent, RelayMessage } from "./types.js";

const AGENT_ID = "agt_self";

function message(overrides: Partial<RelayMessage> = {}): RelayMessage {
  return {
    id: "msg_1",
    conversation_id: "cnv_1",
    sequence: 7,
    sender: { kind: "user", id: "usr_1" },
    parts: [{ part_index: 0, type: "text", text: "hello" }],
    reply_to: null,
    fallback_text: "hello",
    status: "sent",
    created_at: "2026-07-17T00:00:00.000Z",
    ...overrides,
  };
}

function event(overrides: Partial<RelayEvent> = {}): RelayEvent {
  return {
    event_id: "evt_1",
    event_type: "message.received",
    agent_id: AGENT_ID,
    created_at: "2026-07-17T00:00:01.000Z",
    data: { message: message() },
    ...overrides,
  };
}

describe("classifyRelayEvent", () => {
  it("maps event types per doc 03 §4", () => {
    expect(classifyRelayEvent({ event_type: "message.received" })).toBe("message");
    expect(classifyRelayEvent({ event_type: "reaction.added" })).toBe("reaction");
    expect(classifyRelayEvent({ event_type: "reaction.removed" })).toBe("reaction");
    expect(classifyRelayEvent({ event_type: "message.delivered" })).toBe("lifecycle");
    expect(classifyRelayEvent({ event_type: "message.read" })).toBe("lifecycle");
    expect(classifyRelayEvent({ event_type: "something.new" })).toBe("unknown");
  });
});

describe("renderRelayPartsText", () => {
  it("joins text parts and inlines link URLs", () => {
    expect(
      renderRelayPartsText([
        { part_index: 0, type: "text", text: "check this" },
        { part_index: 1, type: "link_preview", url: "https://example.com/x" },
        { part_index: 2, type: "text", text: "ok?" },
      ]),
    ).toBe("check this\nhttps://example.com/x\nok?");
  });

  it("renders data parts as a compact JSON fence", () => {
    expect(renderRelayPartsText([{ part_index: 0, type: "data", data: { a: 1 } }])).toBe(
      '```json\n{"a":1}\n```',
    );
  });

  it("renders media and voice placeholders until the download path ships", () => {
    expect(
      renderRelayPartsText([
        { part_index: 0, type: "media", url: "https://cdn/x.png" },
        { part_index: 1, type: "voice_memo", url: "https://cdn/y.m4a" },
      ]),
    ).toBe("<media:attachment>\n<media:voice>");
  });
});

describe("echo guard", () => {
  it("drops the agent's own echoed sends", () => {
    expect(isRelayEchoMessage({ sender: { kind: "agent", id: AGENT_ID } }, AGENT_ID)).toBe(true);
    expect(isRelayEchoMessage({ sender: { kind: "user", id: AGENT_ID } }, AGENT_ID)).toBe(false);
    expect(isRelayEchoMessage({ sender: { kind: "agent", id: "agt_other" } }, AGENT_ID)).toBe(
      false,
    );
  });
});

describe("buildRelayInboundFacts", () => {
  it("builds the dispatchable fact bundle for a user message", () => {
    const facts = buildRelayInboundFacts(event(), { agentId: AGENT_ID });
    expect(facts).toEqual({
      eventId: "evt_1",
      messageId: "msg_1",
      conversationId: "cnv_1",
      senderId: "usr_1",
      senderKind: "user",
      text: "hello",
      timestamp: Date.parse("2026-07-17T00:00:00.000Z"),
    });
  });

  it("carries the reply target", () => {
    const facts = buildRelayInboundFacts(
      event({ data: { message: message({ reply_to: { message_id: "msg_0", part_index: 0 } }) } }),
      { agentId: AGENT_ID },
    );
    expect(facts?.replyToId).toBe("msg_0");
  });

  it("returns null for echoes of our own agent", () => {
    const facts = buildRelayInboundFacts(
      event({ data: { message: message({ sender: { kind: "agent", id: AGENT_ID } }) } }),
      { agentId: AGENT_ID },
    );
    expect(facts).toBeNull();
  });

  it("returns null for receipts and reactions", () => {
    expect(
      buildRelayInboundFacts(event({ event_type: "message.read" }), { agentId: AGENT_ID }),
    ).toBeNull();
    expect(
      buildRelayInboundFacts(event({ event_type: "reaction.added" }), { agentId: AGENT_ID }),
    ).toBeNull();
  });

  it("falls back to fallback_text when parts render empty", () => {
    const facts = buildRelayInboundFacts(
      event({ data: { message: message({ parts: [], fallback_text: "fallback body" }) } }),
      { agentId: AGENT_ID },
    );
    expect(facts?.text).toBe("fallback body");
  });

  it("returns null when there is no renderable content at all", () => {
    const facts = buildRelayInboundFacts(
      event({ data: { message: message({ parts: [], fallback_text: "" }) } }),
      { agentId: AGENT_ID },
    );
    expect(facts).toBeNull();
  });

  it("returns null when the message is missing", () => {
    expect(buildRelayInboundFacts(event({ data: {} }), { agentId: AGENT_ID })).toBeNull();
  });
});
