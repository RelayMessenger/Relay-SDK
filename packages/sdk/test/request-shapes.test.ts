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
      || url.pathname.endsWith("/share_contact_card")
      || url.pathname.endsWith("/typing")
    ))
    || (method === "DELETE" && (
      url.pathname.startsWith("/v1/attachments/")
      || url.pathname.startsWith("/v1/webhook-subscriptions/")
      || url.pathname === "/v1/blocked_handles"
      || url.pathname.endsWith("/typing")
    ))
  );
  if (noContent) return new Response(null, { status: 204 });
  if (method === "GET" && url.pathname === "/v1/chats") {
    return Response.json({ chats: [], next_cursor: null });
  }
  if (method === "POST" && url.pathname === "/v1/contact_requests") {
    return Response.json({ state: "pending" }, { status: 201 });
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
  it("marks Read only through an explicit chats.markAsRead call", async () => {
    const calls: Captured[] = [];
    const client = new Relay({
      apiKey: "agent-token",
      baseURL: "https://api.example.test",
      maxRetries: 0,
      fetch: responder(calls),
    });

    await client.chats.messages.list("chat/id");
    await client.messages.retrieve("message-id");

    expect(calls.filter((call) => call.url.pathname.endsWith("/read")))
      .toEqual([]);

    await client.chats.markAsRead("chat/id");

    const readCalls = calls.filter((call) =>
      call.url.pathname.endsWith("/read"));
    expect(readCalls).toHaveLength(1);
    expect(readCalls[0]).toMatchObject({
      method: "POST",
      body: undefined,
    });
    expect(readCalls[0]!.url.pathname).toBe("/v1/chats/chat%2Fid/read");
  });

  it("exposes every current operation and no extra HTTP route", async () => {
    const calls: Captured[] = [];
    const client = new Relay({
      apiKey: "agent-token",
      baseURL: "https://api.example.test/",
      maxRetries: 0,
      fetch: responder(calls),
    });

    await client.chats.create({
      from: "echo.agent",
      to: ["bob"],
      message: {
        parts: [{ type: "text", value: "hello" }],
        idempotency_key: "chat-create-key",
      },
    });
    await client.chats.listChats({ cursor: "chat-cursor", limit: 20 });
    await client.chats.retrieve("chat-id");
    await client.chats.update("chat-id", { display_name: "Team" });
    await client.chats.participants.add("chat-id", { handle: "research.agent" });
    await client.chats.participants.remove("chat-id", { handle: "research.agent" });
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
    const contactRequest = await client.contactRequests.create({
      handle: "advait",
    });
    expect(contactRequest).toEqual({ state: "pending" });

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

    const createChat = calls[0]!;
    expect(createChat.headers.get("idempotency-key")).toBe("chat-create-key");
    expect(JSON.parse(String(createChat.body))).toEqual({
      from: "echo.agent",
      to: ["bob"],
      message: {
        parts: [{ type: "text", value: "hello" }],
        idempotency_key: "chat-create-key",
      },
    });

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
      handle: "research.agent",
    });

    const contactUpdate = calls.find((call) =>
      call.method === "PATCH" && call.url.pathname === "/v1/contact_card")!;
    expect(contactUpdate.url.searchParams.get("handle")).toBe("echo");
    expect(JSON.parse(String(contactUpdate.body))).toEqual({
      first_name: "New Echo",
    });

    const createContactRequest = calls.at(-1)!;
    expect(createContactRequest.headers.get("idempotency-key")).toBeNull();
    expect(JSON.parse(String(createContactRequest.body))).toEqual({
      handle: "advait",
    });

    expect(calls.some((call) =>
      call.url.pathname === "/v1/websocket")).toBe(false);
  });

  it.each([
    { name: "one-agent direct Chat", to: ["bob"] },
    { name: "multi-agent group Chat", to: ["bob", "research.agent"] },
  ])("preserves agent-initiated creation of a $name", async ({ to }) => {
    const calls: Captured[] = [];
    const client = new Relay({
      apiKey: "agent-token",
      baseURL: "https://api.example.test",
      maxRetries: 0,
      fetch: responder(calls),
    });
    // The authenticated sender is an agent; Bob is the single human user.
    const body = {
      from: "echo.agent",
      to,
      message: { parts: [{ type: "text" as const, value: "hello" }] },
    };
    await client.chats.create(body);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.pathname).toBe("/v1/chats");
    expect(calls[0]!.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.body))).toEqual(body);
  });

  it("exposes only the approved resource surface", () => {
    const client = new Relay({
      apiKey: "token",
      fetch: responder([]),
    });
    const methods = (value: object): string[] =>
      Object.getOwnPropertyNames(Object.getPrototypeOf(value))
        .filter((name) => name !== "constructor")
        .sort();

    expect(Object.keys(client).sort()).toEqual([
      "attachments",
      "baseURL",
      "blockedHandles",
      "chats",
      "contactCard",
      "contactRequests",
      "messages",
      "webhookEvents",
      "webhookSubscriptions",
      "webhooks",
      "websocket",
    ]);
    expect(methods(client.chats)).toEqual([
      "create",
      "leaveChat",
      "listChats",
      "markAsRead",
      "retrieve",
      "sendVoicememo",
      "shareContactCard",
      "startTyping",
      "stopTyping",
      "update",
    ]);
    expect(methods(client.messages)).toEqual([
      "addReaction",
      "create",
      "listMessagesThread",
      "retrieve",
    ]);
    expect(methods(client.chats.messages)).toEqual(["list", "send"]);
    expect(methods(client.chats.participants)).toEqual(["add", "remove"]);
    expect(methods(client.attachments)).toEqual([
      "create",
      "delete",
      "retrieve",
      "upload",
    ]);
    expect(methods(client.webhookEvents)).toEqual(["list"]);
    expect(methods(client.webhookSubscriptions)).toEqual([
      "create",
      "delete",
      "list",
      "retrieve",
      "update",
    ]);
    expect(methods(client.contactCard)).toEqual([
      "create",
      "retrieve",
      "update",
    ]);
    expect(methods(client.contactRequests)).toEqual(["create"]);
    expect(methods(client.blockedHandles)).toEqual([
      "block",
      "list",
      "unblock",
    ]);
    expect(methods(client.websocket)).toEqual(["run"]);
    expect(methods(client.webhooks)).toEqual(["unwrap", "verify"]);
  });
});
