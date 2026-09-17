import { describe, expect, it } from "vitest";
import Relay from "../src/index.js";
import type { MessageSendParams } from "../src/types.js";

interface Captured {
  url: URL;
  method: string;
  body: BodyInit | null | undefined;
}

const responder = (calls: Captured[]) => async (
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> => {
  calls.push({
    url: new URL(input instanceof Request ? input.url : input),
    method: init?.method ?? "GET",
    body: init?.body,
  });
  return Response.json({});
};

const client = (calls: Captured[]) =>
  new Relay({
    apiKey: "agent-token",
    baseURL: "https://api.example.test",
    maxRetries: 0,
    fetch: responder(calls),
  });

describe("buttons request shapes", () => {
  it("serializes a text part next to a buttons part verbatim", async () => {
    const calls: Captured[] = [];
    const body: MessageSendParams = {
      message: {
        parts: [
          { type: "text", value: "Ship it?" },
          {
            type: "buttons",
            items: [
              { id: "approve", label: "Approve" },
              { url: "https://example.com", label: "Open" },
            ],
          },
        ],
      },
    };

    await client(calls).chats.messages.send("chat-id", body);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url.pathname).toBe("/v1/chats/chat-id/messages");
    expect(calls[0]!.body).toBe(JSON.stringify(body));
    expect(JSON.parse(String(calls[0]!.body))).toEqual(body);
  });

  it("serializes a button_reply part with reply_to verbatim", async () => {
    const calls: Captured[] = [];
    const body: MessageSendParams = {
      message: {
        parts: [{ type: "button_reply", id: "approve", label: "Approve" }],
        reply_to: { message_id: "message-id", part_index: 1 },
      },
    };

    await client(calls).chats.messages.send("chat-id", body);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toBe(JSON.stringify(body));
    expect(JSON.parse(String(calls[0]!.body))).toEqual(body);
  });

  it.each([0, 1])("preserves ordinary text replies and reactions at part %i", async (partIndex) => {
    // Targets are opaque IDs: preserve each caller-selected part index.
    // The server, not the SDK, resolves and validates the target's stored type.
    const calls: Captured[] = [];
    const relay = client(calls);
    const body: MessageSendParams = {
      message: {
        parts: [{ type: "text", value: "Thanks!" }],
        reply_to: { message_id: "message-id", part_index: partIndex },
      },
    };
    await relay.chats.messages.send("chat-id", body);
    await relay.messages.addReaction("message-id", {
      operation: "add", type: "love", part_index: partIndex,
    });
    expect(JSON.parse(String(calls[0]!.body))).toEqual(body);
    expect(calls[1]!.url.pathname).toBe("/v1/messages/message-id/reactions");
    expect(JSON.parse(String(calls[1]!.body))).toEqual({
      operation: "add", type: "love", part_index: partIndex,
    });
  });

});
