import {
  AdapterRateLimitError,
  AuthenticationError,
  NetworkError,
  PermissionError,
  ResourceNotFoundError,
  ValidationError,
} from "@chat-adapter/shared";
import { describe, expect, it, vi } from "vitest";
import {
  RelayApiError,
  RelayClient,
} from "../src/index.js";
import { IDS, jsonResponse } from "./helpers.js";

interface Call {
  body: unknown;
  headers: Headers;
  method: string;
  url: string;
}

function harness(
  responder: (call: Call) => Response = () =>
    jsonResponse({
      chat_id: IDS.chat,
      message: {
        created_at: "2026-08-30T12:00:00.000Z",
        delivery_status: "sent",
        id: IDS.message,
        parts: [{ reactions: null, type: "text", value: "hi" }],
        sent_at: null,
      },
    }, 202),
) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      let body: unknown;
      if (typeof init?.body === "string") {
        body = JSON.parse(init.body) as unknown;
      } else {
        body = init?.body;
      }
      const call: Call = {
        body,
        headers: new Headers(init?.headers),
        method: init?.method ?? "GET",
        url: String(input),
      };
      calls.push(call);
      return responder(call);
    },
  );
  return { calls, fetchMock };
}

describe("RelayClient", () => {
  it("uses the locked chat send route with the caller's idempotency key", async () => {
    const { calls, fetchMock } = harness();
    const token = vi
      .fn<() => string>()
      .mockReturnValueOnce("token-one")
      .mockReturnValueOnce("token-two");
    const client = new RelayClient({
      fetch: fetchMock as typeof fetch,
      token,
    });

    await client.sendMessage({
      chatId: IDS.chat,
      idempotencyKey: "think-action:one",
      parts: [{ type: "text", value: "hi" }],
    });
    await client.sendMessage({
      chatId: IDS.chat,
      idempotencyKey: "think-action:two",
      parts: [{ type: "text", value: "again" }],
      replyTo: { messageId: IDS.reply },
    });

    expect(token).toHaveBeenCalledTimes(2);
    expect(calls[0]?.url).toBe(
      `https://api.relayapp.im/v1/chats/${IDS.chat}/messages`,
    );
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.headers.get("authorization")).toBe(
      "Bearer token-one",
    );
    expect(calls[0]?.headers.get("idempotency-key")).toBe(
      "think-action:one",
    );
    expect(calls[0]?.body).toEqual({
      message: { parts: [{ type: "text", value: "hi" }] },
    });
    expect(calls[1]?.body).toEqual({
      message: {
        parts: [{ type: "text", value: "again" }],
        reply_to: { message_id: IDS.reply },
      },
    });
    expect(calls[1]?.headers.get("idempotency-key")).toBe(
      "think-action:two",
    );
  });

  it("calls exact typing, read, reaction, and fetch routes", async () => {
    const { calls, fetchMock } = harness((call) => {
      if (call.method === "GET") {
        if (call.url.endsWith(`/messages/${IDS.message}`)) {
          return jsonResponse({
            chat_id: IDS.chat,
            created_at: "2026-08-30T12:00:00.000Z",
            delivery_status: "sent",
            id: IDS.message,
            is_from_me: false,
            is_system_message: false,
            parts: [],
            updated_at: "2026-08-30T12:00:00.000Z",
          });
        }
        return jsonResponse({ messages: [], next_cursor: null });
      }
      return jsonResponse(undefined, 204);
    });
    const client = new RelayClient({
      fetch: fetchMock as typeof fetch,
      token: "token",
    });

    await client.setTyping(IDS.chat, true);
    await client.setTyping(IDS.chat, false);
    await client.markChatRead(IDS.chat);
    await client.react({
      messageId: IDS.message,
      operation: "add",
      type: "like",
    });
    await client.getMessages({
      chatId: IDS.chat,
      cursor: "opaque cursor",
      limit: 25,
    });
    await client.getMessage(IDS.message);

    expect(calls.map(({ method, url }) => [method, url])).toEqual([
      [
        "POST",
        `https://api.relayapp.im/v1/chats/${IDS.chat}/typing`,
      ],
      [
        "DELETE",
        `https://api.relayapp.im/v1/chats/${IDS.chat}/typing`,
      ],
      [
        "POST",
        `https://api.relayapp.im/v1/chats/${IDS.chat}/read`,
      ],
      [
        "POST",
        `https://api.relayapp.im/v1/messages/${IDS.message}/reactions`,
      ],
      [
        "GET",
        `https://api.relayapp.im/v1/chats/${IDS.chat}/messages?cursor=opaque+cursor&limit=25`,
      ],
      [
        "GET",
        `https://api.relayapp.im/v1/messages/${IDS.message}`,
      ],
    ]);
  });

  it("allocates, then uploads with only Relay-provided headers", async () => {
    const { calls, fetchMock } = harness((call) => {
      if (call.url.endsWith("/v1/attachments")) {
        return jsonResponse({
          attachment_id: IDS.attachment,
          download_url: "https://cdn.relay.test/download",
          expires_at: "2026-08-30T12:15:00.000Z",
          http_method: "PUT",
          required_headers: {
            "Content-Type": "text/plain",
            "x-upload-token": "opaque",
          },
          upload_url: "https://storage.relay.test/upload",
        });
      }
      return new Response(null, { status: 200 });
    });
    const token = vi.fn(() => "rotating-token");
    const client = new RelayClient({
      fetch: fetchMock as typeof fetch,
      token,
    });

    const allocation = await client.uploadAttachment({
      body: new TextEncoder().encode("hello"),
      contentType: "text/plain",
      filename: "hello.txt",
    });

    expect(allocation.attachment_id).toBe(IDS.attachment);
    expect(token).toHaveBeenCalledTimes(1);
    expect(calls[0]?.body).toEqual({
      content_type: "text/plain",
      filename: "hello.txt",
      size_bytes: 5,
    });
    expect(calls[1]?.url).toBe("https://storage.relay.test/upload");
    expect(calls[1]?.method).toBe("PUT");
    expect(
      Object.fromEntries(calls[1]!.headers.entries()),
    ).toEqual({
      "content-type": "text/plain",
      "x-upload-token": "opaque",
    });
    expect(calls[1]?.headers.has("authorization")).toBe(false);
  });

  it("surfaces Relay status and error code for a status the shared vocabulary does not name", async () => {
    const { fetchMock } = harness(() =>
      jsonResponse(
        {
          error: {
            code: "idempotency_conflict",
            message: "That key was used with a different body.",
          },
        },
        409,
      ),
    );
    const client = new RelayClient({
      fetch: fetchMock as typeof fetch,
      token: "token",
    });
    await expect(client.getMessage(IDS.message)).rejects.toMatchObject({
      relayCode: "idempotency_conflict",
      status: 409,
    } satisfies Partial<RelayApiError>);
  });
});

describe("RelayClient error mapping", () => {
  function clientThatFails(status: number, body: unknown) {
    const { fetchMock } = harness(() => jsonResponse(body, status));
    return new RelayClient({
      fetch: fetchMock as typeof fetch,
      token: "token",
    });
  }

  function relayError(code: string, message: string, extra = {}) {
    return { error: { code, message, ...extra } };
  }

  it("maps 401 to AuthenticationError", async () => {
    const client = clientThatFails(
      401,
      relayError("unauthorized", "Agent Token is invalid."),
    );
    const error = await client
      .getMessage(IDS.message)
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(AuthenticationError);
    expect((error as AuthenticationError).message).toBe(
      "Agent Token is invalid.",
    );
    expect((error as AuthenticationError).adapter).toBe("relay");
  });

  it("maps 403 to PermissionError", async () => {
    const client = clientThatFails(
      403,
      relayError("forbidden", "reach this Chat"),
    );
    const error = await client
      .getChat(IDS.chat)
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(PermissionError);
    expect((error as PermissionError).action).toBe("reach this Chat");
    expect((error as PermissionError).requiredScope).toBe("forbidden");
  });

  it("maps 404 to ResourceNotFoundError naming the resource from the route", async () => {
    const client = clientThatFails(
      404,
      relayError("not_found", "Message was not found."),
    );
    const error = await client
      .getMessage(IDS.message)
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ResourceNotFoundError);
    expect((error as ResourceNotFoundError).resourceType).toBe("message");
    expect((error as ResourceNotFoundError).resourceId).toBe(IDS.message);
  });

  it("maps 404 on a chat route to the chat resource", async () => {
    const client = clientThatFails(
      404,
      relayError("not_found", "Chat was not found."),
    );
    const error = await client
      .getChat(IDS.chat)
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ResourceNotFoundError);
    expect((error as ResourceNotFoundError).resourceType).toBe("chat");
    expect((error as ResourceNotFoundError).resourceId).toBe(IDS.chat);
  });

  it("maps 429 to AdapterRateLimitError carrying the contract's retry_after", async () => {
    const client = clientThatFails(
      429,
      relayError("rate_limited", "Slow down.", { retry_after: 30 }),
    );
    const error = await client
      .getMessage(IDS.message)
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(AdapterRateLimitError);
    expect((error as AdapterRateLimitError).retryAfter).toBe(30);
    expect((error as AdapterRateLimitError).message).toContain(
      "retry after 30s",
    );
  });

  it("maps 429 without retry_after to AdapterRateLimitError with no wait", async () => {
    const client = clientThatFails(
      429,
      relayError("rate_limited", "Slow down."),
    );
    const error = await client
      .getMessage(IDS.message)
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(AdapterRateLimitError);
    expect((error as AdapterRateLimitError).retryAfter).toBeUndefined();
  });

  it("maps 400 and 422 to ValidationError", async () => {
    for (const status of [400, 422]) {
      const client = clientThatFails(
        status,
        relayError("invalid_request", `Rejected with ${status}.`),
      );
      const error = await client
        .getMessage(IDS.message)
        .catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).message).toBe(
        `Rejected with ${status}.`,
      );
    }
  });

  it("maps every 5xx to NetworkError", async () => {
    for (const status of [500, 502, 503]) {
      const client = clientThatFails(
        status,
        relayError("server_error", `Relay is unwell (${status}).`),
      );
      const error = await client
        .getMessage(IDS.message)
        .catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(NetworkError);
      expect((error as NetworkError).message).toBe(
        `Relay is unwell (${status}).`,
      );
    }
  });

  it("leaves an unmapped 4xx as RelayApiError", async () => {
    const client = clientThatFails(
      418,
      relayError("teapot", "Relay declines to brew."),
    );
    const error = await client
      .getMessage(IDS.message)
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(RelayApiError);
    expect((error as RelayApiError).status).toBe(418);
    expect((error as RelayApiError).relayCode).toBe("teapot");
  });
});
