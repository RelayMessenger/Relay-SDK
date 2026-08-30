import { describe, expect, it } from "vitest";
import Relay, { RELAY_V1_OPERATIONS } from "../src/index.js";

interface Captured {
  url: URL;
  method: string;
  headers: Headers;
  body: BodyInit | null | undefined;
}

const responder = (calls: Captured[]) => async (
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> => {
  const url = new URL(input instanceof Request ? input.url : input);
  const method = init?.method ?? "GET";
  calls.push({
    url,
    method,
    headers: new Headers(init?.headers),
    body: init?.body,
  });
  const noContent = (
    (method === "POST" && (
      url.pathname.endsWith("/read")
      || url.pathname.endsWith("/delivered")
      || url.pathname.endsWith("/share_contact_card")
      || url.pathname.endsWith("/typing")
    ))
    || (method === "DELETE" && (
      url.pathname.startsWith("/v1/attachments/")
      || url.pathname.startsWith("/v1/webhook-subscriptions/")
      || url.pathname.startsWith("/v1/me/conversations/")
      || url.pathname === "/v1/blocked_handles"
      || url.pathname.endsWith("/typing")
    ))
  );
  if (noContent) return new Response(null, { status: 204 });
  if (method === "GET" && url.pathname === "/v1/chats") {
    return Response.json({ chats: [], next_cursor: null });
  }
  if (
    method === "GET"
    && (
      url.pathname.endsWith("/messages")
      || url.pathname.endsWith("/thread")
    )
  ) {
    return Response.json({ messages: [], next_cursor: null });
  }
  return Response.json({});
};

describe("Relay v1 request shapes", () => {
  it("exposes every current operation and no extra HTTP route", async () => {
    const calls: Captured[] = [];
    const client = new Relay({
      apiKey: "agent-token",
      baseURL: "https://api.example.test/",
      maxRetries: 0,
      fetch: responder(calls),
    });

    await client.chats.create({
      from: "alice",
      to: ["bob"],
      message: { parts: [{ type: "text", value: "hello" }] },
    });
    await client.chats.listChats({ cursor: "chat-cursor", limit: 20 });
    await client.chats.retrieve("chat-id");
    await client.chats.update("chat-id", { display_name: "Team" });
    await client.chats.participants.add("chat-id", { handle: "carol" });
    await client.chats.participants.remove("chat-id", { handle: "carol" });
    await client.chats.leaveChat("chat-id");
    await client.chats.startTyping("chat-id");
    await client.chats.stopTyping("chat-id");
    await client.chats.markAsRead("chat-id");
    await client.chats.shareContactCard("chat-id");
    await client.messages.create({
      to: ["bob"],
      message: { parts: [{ type: "text", value: "hello" }] },
      "Idempotency-Key": "message-key",
    });
    await client.chats.messages.send("chat-id", {
      message: {
        parts: [{ type: "text", value: "again" }],
        idempotency_key: "chat-message-key",
      },
    });
    await client.chats.messages.list("chat-id", {
      cursor: "message-cursor",
      limit: 50,
    });
    await client.messages.listMessagesThread("message-id", {
      cursor: "thread-cursor",
      limit: 25,
      order: "desc",
    });
    await client.chats.sendVoicememo("chat-id", {
      attachment_id: "attachment-id",
    });
    await client.messages.retrieve("message-id");
    await client.messages.addReaction("message-id", {
      operation: "add",
      type: "love",
      part_index: 0,
    });
    await client.attachments.create({
      filename: "photo.png",
      content_type: "image/png",
      size_bytes: 1,
      width: 1,
      height: 1,
    });
    await client.attachments.retrieve("attachment-id");
    await client.attachments.delete("attachment-id");
    await client.blockedHandles.list();
    await client.blockedHandles.block({ handle: "carol", reason: "spam" });
    await client.blockedHandles.unblock({ handle: "carol" });
    await client.webhookEvents.list();
    await client.webhookSubscriptions.create({
      target_url: "https://receiver.test/webhook",
      subscribed_events: ["message.received"],
    });
    await client.webhookSubscriptions.list();
    await client.webhookSubscriptions.retrieve("subscription-id");
    await client.webhookSubscriptions.update("subscription-id", {
      is_active: false,
    });
    await client.webhookSubscriptions.delete("subscription-id");
    await client.contactCard.retrieve({ handle: "echo" });
    await client.contactCard.create({ handle: "echo", first_name: "Echo" });
    await client.contactCard.update({
      handle: "echo",
      first_name: "New Echo",
    });
    await client.messages.acknowledgeDelivered("message-id");
    await client.chats.deleteConversation("chat-id");

    expect(calls.map((call) => [call.method, call.url.pathname])).toEqual(
      RELAY_V1_OPERATIONS.map((operation) => [
        operation.method,
        operation.path
          .replace("{chatId}", "chat-id")
          .replace("{messageId}", "message-id")
          .replace("{attachmentId}", "attachment-id")
          .replace("{subscriptionId}", "subscription-id"),
      ]),
    );
    expect(calls.every((call) =>
      call.headers.get("authorization") === "Bearer agent-token")).toBe(true);

    const sharedContactCard = calls[10]!;
    expect(sharedContactCard.body).toBeUndefined();

    const createMessage = calls[11]!;
    expect(createMessage.headers.get("idempotency-key")).toBe("message-key");
    expect(JSON.parse(String(createMessage.body))).toEqual({
      to: ["bob"],
      message: { parts: [{ type: "text", value: "hello" }] },
    });

    const chatMessage = calls[12]!;
    expect(chatMessage.headers.get("idempotency-key")).toBe("chat-message-key");
    expect(JSON.parse(String(chatMessage.body))).toEqual({
      message: {
        parts: [{ type: "text", value: "again" }],
        idempotency_key: "chat-message-key",
      },
    });

    const removeParticipant = calls[5]!;
    expect(JSON.parse(String(removeParticipant.body))).toEqual({
      handle: "carol",
    });

    const contactUpdate = calls.find((call) =>
      call.method === "PATCH" && call.url.pathname === "/v1/contact_card")!;
    expect(contactUpdate.url.searchParams.get("handle")).toBe("echo");
    expect(JSON.parse(String(contactUpdate.body))).toEqual({
      first_name: "New Echo",
    });

    expect(calls.at(-1)?.url.pathname).toBe("/v1/me/conversations/chat-id");
    expect(calls.some((call) =>
      call.url.pathname === "/v1/websocket")).toBe(false);
  });

  it("exposes real typing commands without polling or invented realtime surfaces", () => {
    const client = new Relay({
      apiKey: "token",
      fetch: responder([]),
    }) as unknown as Record<string, unknown>;
    expect(client).not.toHaveProperty("pollEvents");
    expect(client).not.toHaveProperty("realtime");
    expect(client).not.toHaveProperty("responding");
    expect(client).not.toHaveProperty("typing");
    expect(client).not.toHaveProperty("socketMode");
    expect(client).not.toHaveProperty("contacts");
    expect(client.chats).not.toHaveProperty("typing");
    expect(client.chats).toHaveProperty("startTyping");
    expect(client.chats).toHaveProperty("stopTyping");
    expect(client.websocket).not.toHaveProperty("createConnection");
    expect(client.websocket).not.toHaveProperty("retrieve");
    expect(client.websocket).not.toHaveProperty("update");
    expect(client.websocket).toHaveProperty("run");
    expect(client.messages).not.toHaveProperty("poll");
  });
});
