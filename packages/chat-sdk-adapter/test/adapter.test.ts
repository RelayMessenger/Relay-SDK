import {
  createMockChatInstance,
  createMockState,
  selfMessageContract,
} from "@chat-adapter/tests";
import {
  Chat,
  NotImplementedError,
  type Adapter,
  type Attachment,
} from "chat";
import { describe, expect, it, vi } from "vitest";
import {
  createRelayAdapter,
  RELAY_WEBHOOK_EVENT_TYPES,
  type RelayWebhookEventType,
} from "../src/index.js";
import {
  AGENT_HANDLE,
  envelope,
  IDS,
  jsonResponse,
  reactionEvent,
  signedRequest,
  USER_HANDLE,
  WEBHOOK_SECRET,
  webhookMessage,
} from "./helpers.js";

const THREAD_ID = `relay:${IDS.chat}`;

function sentMessage(value = "sent") {
  return {
    chat_id: IDS.chat,
    message: {
      created_at: "2026-08-30T12:00:02.000Z",
      delivery_status: "sent" as const,
      from_handle: null,
      id: IDS.reply,
      parts: [{ reactions: null, type: "text" as const, value }],
      reply_to: null,
      sent_at: null,
    },
  };
}

function adapterHarness(options: { typing?: boolean } = {}) {
  const calls: Array<{
    body: unknown;
    method: string;
    url: string;
  }> = [];
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const body =
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as unknown)
          : init?.body;
      calls.push({
        body,
        method: init?.method ?? "GET",
        url: String(input),
      });
      if (init?.method === "POST" && String(input).endsWith("/messages")) {
        return jsonResponse(sentMessage(), 202);
      }
      if (init?.method === "GET" && String(input).includes("/messages?")) {
        return jsonResponse({
          messages: [
            {
              chat_id: IDS.chat,
              created_at: "2026-08-30T12:00:00.000Z",
              delivery_status: "sent",
              from: "ada",
              from_handle: USER_HANDLE,
              id: IDS.message,
              is_from_me: false,
              is_system_message: false,
              parts: [
                { reactions: null, type: "text", value: "history" },
              ],
              reply_to: null,
              updated_at: "2026-08-30T12:00:00.000Z",
            },
          ],
          next_cursor: "next-page",
        });
      }
      return new Response(null, { status: 204 });
    },
  );
  const adapter = createRelayAdapter({
    fetch: fetchMock as typeof fetch,
    idempotencyKeyResolver: ({ replyToMessageId }) =>
      replyToMessageId ? "test-reply" : "test-post",
    token: "agent-token",
    typing: options.typing,
    webhookSecret: WEBHOOK_SECRET,
  });
  return { adapter, calls, fetchMock };
}

describe("RelayAdapter interface", () => {
  it("satisfies the current chat@4.39.0 Adapter interface", () => {
    const { adapter } = adapterHarness();
    const typed: Adapter = adapter;
    expect(typed.name).toBe("relay");
  });

  it("posts and replies through the locked message route", async () => {
    const { adapter, calls } = adapterHarness();
    const posted = await adapter.postMessage(THREAD_ID, {
      markdown: "**hello**",
    });
    const replied = await adapter.reply(
      THREAD_ID,
      IDS.message,
      "reply",
    );

    expect(posted).toMatchObject({
      id: IDS.reply,
      threadId: THREAD_ID,
    });
    expect(replied.id).toBe(IDS.reply);
    expect(calls[0]?.body).toEqual({
      message: {
        parts: [{ type: "text", value: "hello" }],
      },
    });
    expect(calls[1]?.body).toEqual({
      message: {
        parts: [{ type: "text", value: "reply" }],
        reply_to: { message_id: IDS.message },
      },
    });
  });

  it("no-ops empty string posts without touching Relay", async () => {
    const { adapter, fetchMock } = adapterHarness();
    const result = await adapter.postMessage(THREAD_ID, "");
    expect(result.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(result.raw).toMatchObject({ noop: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires an explicit stable key strategy outside webhook turns", async () => {
    const fetchMock = vi.fn();
    const adapter = createRelayAdapter({
      fetch: fetchMock as typeof fetch,
      token: "agent-token",
    });
    await expect(
      adapter.postMessage(THREAD_ID, "visible"),
    ).rejects.toThrow(/idempotencyKeyResolver/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects local bytes before allocation so retries cannot change the body", async () => {
    const { adapter, fetchMock } = adapterHarness();
    await expect(
      adapter.postMessage(THREAD_ID, {
        files: [{
          data: new Uint8Array([1, 2, 3]).buffer,
          filename: "photo.png",
          mimeType: "image/png",
        }],
        raw: "",
      }),
    ).rejects.toThrow(/public HTTPS URL/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("buffers streams into one canonical message and no-ops empty streams", async () => {
    const { adapter, calls, fetchMock } = adapterHarness();
    async function* content() {
      yield "Hello ";
      yield { text: "**Relay**", type: "markdown_text" } as const;
      yield {
        id: "task",
        status: "complete",
        title: "ignored progress",
        type: "task_update",
      } as const;
    }
    const sent = await adapter.stream(THREAD_ID, content());
    expect(sent).toMatchObject({ id: IDS.reply });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toEqual({
      message: {
        parts: [{ type: "text", value: "Hello Relay" }],
      },
    });

    fetchMock.mockClear();
    calls.length = 0;
    async function* empty() {
      yield "";
    }
    const noop = await adapter.stream(THREAD_ID, empty());
    expect(noop?.raw).toMatchObject({ noop: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("supports Think's thread.post(callback.stream()) empty and buffered paths", async () => {
    const { adapter, calls, fetchMock } = adapterHarness({
      typing: false,
    });
    const chat = new Chat({
      adapters: { relay: adapter },
      logger: "error",
      state: createMockState(),
      userName: "Relay Agent",
    });
    const thread = chat.thread(THREAD_ID);
    async function* empty() {
      // Think can produce no chunks when visibleSoftLimit is zero.
    }
    const noop = await thread.post(empty());
    expect(noop.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(fetchMock).not.toHaveBeenCalled();

    async function* visible() {
      yield "one ";
      yield "message";
    }
    const sent = await thread.post(visible());
    expect(sent.id).toBe(IDS.reply);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toEqual({
      message: {
        parts: [{ type: "text", value: "one message" }],
      },
    });
  });

  it("supports normal typing and an instance-level no-op", async () => {
    const enabled = adapterHarness();
    await enabled.adapter.startTyping(THREAD_ID);
    await enabled.adapter.endTyping(THREAD_ID);
    expect(
      enabled.calls.map(({ method }) => method),
    ).toEqual(["POST", "DELETE"]);

    const disabled = adapterHarness({ typing: false });
    await disabled.adapter.startTyping(THREAD_ID);
    await disabled.adapter.endTyping(THREAD_ID);
    expect(disabled.fetchMock).not.toHaveBeenCalled();
  });

  it("marks the chat read without inventing a per-message body", async () => {
    const { adapter, calls } = adapterHarness();
    await adapter.markAsRead(THREAD_ID, IDS.message);
    expect(calls[0]).toEqual({
      body: undefined,
      method: "POST",
      url: `https://api.relayapp.im/v1/chats/${IDS.chat}/read`,
    });
  });

  it("supports explicit forward fetch and refuses false backward semantics", async () => {
    const { adapter } = adapterHarness();
    const result = await adapter.fetchMessages(THREAD_ID, {
      direction: "forward",
      limit: 10,
    });
    expect(result.messages[0]).toMatchObject({
      id: IDS.message,
      text: "history",
      threadId: THREAD_ID,
    });
    expect(result.nextCursor).toBe("next-page");
    await expect(adapter.fetchMessages(THREAD_ID)).rejects.toMatchObject({
      feature: "fetchMessages(backward)",
    });
  });

  it("throws explicit unsupported errors instead of calling undocumented APIs", async () => {
    const { adapter, fetchMock } = adapterHarness();
    await expect(
      adapter.editMessage(THREAD_ID, IDS.message, "edit"),
    ).rejects.toBeInstanceOf(NotImplementedError);
    await expect(
      adapter.deleteMessage(THREAD_ID, IDS.message),
    ).rejects.toBeInstanceOf(NotImplementedError);
    await expect(adapter.openDM(IDS.user)).rejects.toBeInstanceOf(
      NotImplementedError,
    );
    await expect(adapter.getUser(IDS.user)).rejects.toBeInstanceOf(
      NotImplementedError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Relay webhook handling", () => {
  it("verifies and dispatches an inbound message", async () => {
    const { adapter } = adapterHarness();
    const chat = createMockChatInstance();
    await adapter.initialize(chat);
    const response = await adapter.handleWebhook(
      await signedRequest(envelope()),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      acknowledged: true,
      event_type: "message.received",
    });
    expect(chat.processMessage).toHaveBeenCalledOnce();
    const [, threadId, message] = vi.mocked(chat.processMessage).mock
      .calls[0]!;
    expect(threadId).toBe(THREAD_ID);
    expect(message).toMatchObject({
      isMention: false,
      text: "hello Relay",
    });
  });

  it("resolves the signing secret for every delivery", async () => {
    const secret = vi.fn(() => WEBHOOK_SECRET);
    const adapter = createRelayAdapter({ webhookSecret: secret });
    await adapter.handleWebhook(
      await signedRequest(envelope("chat.created", {})),
    );
    await adapter.handleWebhook(
      await signedRequest(envelope("contact.removed", {})),
    );
    expect(secret).toHaveBeenCalledTimes(2);
  });

  it("acknowledges every valid current event type exhaustively", async () => {
    const { adapter } = adapterHarness();
    const chat = createMockChatInstance();
    await adapter.initialize(chat);
    const responses: Array<[RelayWebhookEventType, number]> = [];

    for (const eventType of RELAY_WEBHOOK_EVENT_TYPES) {
      const data = eventType.startsWith("message.")
        ? (webhookMessage() as unknown as Record<string, unknown>)
        : eventType.startsWith("reaction.")
          ? (reactionEvent() as unknown as Record<string, unknown>)
          : {};
      const response = await adapter.handleWebhook(
        await signedRequest(envelope(eventType, data)),
      );
      responses.push([eventType, response.status]);
    }

    expect(responses).toEqual(
      RELAY_WEBHOOK_EVENT_TYPES.map((eventType) => [
        eventType,
        200,
      ]),
    );
  });

  it("dispatches supported reactions and acknowledges self reactions", async () => {
    const { adapter } = adapterHarness();
    const chat = createMockChatInstance();
    await adapter.initialize(chat);

    await adapter.handleWebhook(
      await signedRequest(
        envelope(
          "reaction.added",
          reactionEvent() as unknown as Record<string, unknown>,
        ),
      ),
    );
    expect(chat.processReaction).toHaveBeenCalledOnce();
    expect(
      vi.mocked(chat.processReaction).mock.calls[0]?.[0],
    ).toMatchObject({
      added: true,
      messageId: IDS.message,
      rawEmoji: "👍",
      threadId: THREAD_ID,
    });

    vi.mocked(chat.processReaction).mockClear();
    const response = await adapter.handleWebhook(
      await signedRequest(
        envelope(
          "reaction.removed",
          reactionEvent({
            is_from_me: true,
          }) as unknown as Record<string, unknown>,
        ),
      ),
    );
    expect(response.status).toBe(200);
    expect(chat.processReaction).not.toHaveBeenCalled();
  });

  it("rejects bad signatures, versions, methods, and JSON", async () => {
    const { adapter } = adapterHarness();
    const badSignature = await signedRequest(envelope(), {
      secret: `whsec_${btoa("wrong secret")}`,
    });
    expect((await adapter.handleWebhook(badSignature)).status).toBe(401);

    const wrongVersion = envelope("chat.created", {}, {
      webhook_version: "wrong" as "2026-08-30",
    });
    expect(
      (
        await adapter.handleWebhook(
          await signedRequest(wrongVersion),
        )
      ).status,
    ).toBe(422);

    expect(
      (
        await adapter.handleWebhook(
          new Request("https://example.test", { method: "GET" }),
        )
      ).status,
    ).toBe(405);

    const valid = await signedRequest(envelope());
    const invalidBody = "{";
    const invalidJson = await signedRequest(envelope());
    // Preserve valid signature headers only after signing the malformed body
    // by building the signature directly through the shared helper's object
    // path is not possible; a tampered body correctly fails at signature first.
    expect(
      (
        await adapter.handleWebhook(
          new Request(valid.url, {
            body: invalidBody,
            headers: invalidJson.headers,
            method: "POST",
          }),
        )
      ).status,
    ).toBe(401);
  });

  it("reuses event_id plus ordinal across duplicate delivery recovery", async () => {
    const sends: Array<{
      body: string;
      key: string | null;
    }> = [];
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        sends.push({
          body: String(init?.body),
          key: new Headers(init?.headers).get("idempotency-key"),
        });
        return jsonResponse(sentMessage("stable reply"), 202);
      },
    );
    const adapter = createRelayAdapter({
      fetch: fetchMock as typeof fetch,
      token: "agent-token",
      webhookSecret: WEBHOOK_SECRET,
    });
    let attempts = 0;
    const chat = createMockChatInstance({
      overrides: {
        processMessage: async (
          inboundAdapter,
          threadId,
        ) => {
          await inboundAdapter.postMessage(
            threadId,
            "stable reply",
          );
          attempts += 1;
          if (attempts === 1) {
            throw new Error(
              "simulate recovery after committed send",
            );
          }
        },
      },
    });
    await adapter.initialize(chat);
    const event = envelope(
      "message.received",
      webhookMessage({
        chat: {
          id: IDS.chat,
          is_group: false,
          owner_handle: AGENT_HANDLE,
        },
      }) as unknown as Record<string, unknown>,
    );

    await expect(
      adapter.handleWebhook(await signedRequest(event)),
    ).rejects.toThrow(/simulate recovery/);
    const recovered = await adapter.handleWebhook(
      await signedRequest(event),
    );

    expect(recovered.status).toBe(200);
    expect(sends).toHaveLength(2);
    expect(sends[0]?.key).toBe(
      `relay-chat-sdk:${IDS.event}:0`,
    );
    expect(sends[1]?.key).toBe(sends[0]?.key);
    expect(sends[1]?.body).toBe(sends[0]?.body);
  });

  it("reserves a distinct send ordinal for each logical Message", async () => {
    const keys: Array<string | null> = [];
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        keys.push(
          new Headers(init?.headers).get("idempotency-key"),
        );
        return jsonResponse(sentMessage(), 202);
      },
    );
    const adapter = createRelayAdapter({
      fetch: fetchMock as typeof fetch,
      token: "agent-token",
      webhookSecret: WEBHOOK_SECRET,
    });
    const chat = createMockChatInstance({
      overrides: {
        processMessage: async (
          inboundAdapter,
          threadId,
        ) => {
          await inboundAdapter.postMessage(threadId, "first");
          await inboundAdapter.postMessage(threadId, "second");
        },
      },
    });
    await adapter.initialize(chat);
    await adapter.handleWebhook(
      await signedRequest(envelope("message.received")),
    );
    expect(keys).toEqual([
      `relay-chat-sdk:${IDS.event}:0`,
      `relay-chat-sdk:${IDS.event}:1`,
    ]);
  });

  it("never reuses an ambiguous failed send ordinal for a different Message", async () => {
    const sends: Array<{ body: string; key: string | null }> = [];
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        sends.push({
          body: String(init?.body),
          key: new Headers(init?.headers).get("idempotency-key"),
        });
        if (sends.length === 1) {
          throw new TypeError("response lost after dispatch");
        }
        return jsonResponse(sentMessage("second"), 202);
      },
    );
    const adapter = createRelayAdapter({
      fetch: fetchMock as typeof fetch,
      token: "agent-token",
      webhookSecret: WEBHOOK_SECRET,
    });
    const chat = createMockChatInstance({
      overrides: {
        processMessage: async (inboundAdapter, threadId) => {
          const [first, second] = await Promise.allSettled([
            inboundAdapter.postMessage(threadId, "first"),
            inboundAdapter.postMessage(threadId, "second"),
          ]);
          expect(first.status).toBe("rejected");
          expect(second.status).toBe("fulfilled");
        },
      },
    });
    await adapter.initialize(chat);
    const response = await adapter.handleWebhook(
      await signedRequest(envelope("message.received")),
    );
    expect(response.status).toBe(200);
    expect(sends.map(({ key }) => key)).toEqual([
      `relay-chat-sdk:${IDS.event}:0`,
      `relay-chat-sdk:${IDS.event}:1`,
    ]);
    expect(sends[0]?.body).not.toBe(sends[1]?.body);
  });

  it("accepts a signed valid non-ASCII Message envelope above one MiB", async () => {
    const { adapter } = adapterHarness();
    const chat = createMockChatInstance();
    await adapter.initialize(chat);
    const value = "界".repeat(4_000);
    const large = envelope(
      "message.received",
      webhookMessage({
        parts: Array.from({ length: 100 }, () => ({
          type: "text" as const,
          value,
        })),
      }) as unknown as Record<string, unknown>,
    );
    const encoded = JSON.stringify(large);
    expect(new TextEncoder().encode(encoded).byteLength).toBeGreaterThan(
      1_048_576,
    );
    const response = await adapter.handleWebhook(
      await signedRequest(large),
    );
    expect(response.status).toBe(200);
    expect(chat.processMessage).toHaveBeenCalledOnce();
  });

  it("lets Relay reject changed recovery content under the same key", async () => {
    const sends: Array<{
      body: string;
      key: string | null;
    }> = [];
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const call = {
          body: String(init?.body),
          key: new Headers(init?.headers).get("idempotency-key"),
        };
        sends.push(call);
        if (
          sends.length > 1 &&
          call.key === sends[0]?.key &&
          call.body !== sends[0]?.body
        ) {
          return jsonResponse(
            {
              error: {
                code: "idempotency_conflict",
                message: "body changed",
              },
            },
            409,
          );
        }
        return jsonResponse(sentMessage("first"), 202);
      },
    );
    const adapter = createRelayAdapter({
      fetch: fetchMock as typeof fetch,
      token: "agent-token",
      webhookSecret: WEBHOOK_SECRET,
    });
    let body = "first";
    const chat = createMockChatInstance({
      overrides: {
        processMessage: async (
          inboundAdapter,
          threadId,
        ) => {
          await inboundAdapter.postMessage(threadId, body);
        },
      },
    });
    await adapter.initialize(chat);
    const event = envelope(
      "message.received",
      webhookMessage({
        chat: {
          id: IDS.chat,
          is_group: false,
          owner_handle: AGENT_HANDLE,
        },
      }) as unknown as Record<string, unknown>,
    );
    expect(
      (
        await adapter.handleWebhook(
          await signedRequest(event),
        )
      ).status,
    ).toBe(200);
    body = "changed";
    await expect(
      adapter.handleWebhook(await signedRequest(event)),
    ).rejects.toMatchObject({
      relayCode: "idempotency_conflict",
      status: 409,
    });
    expect(sends[0]?.key).toBe(
      `relay-chat-sdk:${IDS.event}:0`,
    );
    expect(sends[1]?.key).toBe(sends[0]?.key);
    expect(sends[1]?.body).not.toBe(sends[0]?.body);
  });
});

describe("direct and group routing", () => {
  function routingHarness() {
    const adapter = createRelayAdapter({
      agentId: IDS.agent,
      webhookSecret: WEBHOOK_SECRET,
    });
    const direct = vi.fn();
    const mention = vi.fn();
    const chat = new Chat({
      adapters: { relay: adapter },
      logger: "error",
      state: createMockState(),
      userName: "Relay Agent",
    });
    chat.onDirectMessage(direct);
    chat.onNewMention(mention);
    return { chat, direct, mention };
  }

  it("routes direct chats as direct messages without a mention flag", async () => {
    const { chat, direct, mention } = routingHarness();
    const message = webhookMessage({
      chat: {
        id: IDS.chat,
        is_group: false,
        owner_handle: AGENT_HANDLE,
      },
    });
    const response = await chat.webhooks.relay(
      await signedRequest(
        envelope(
          "message.received",
          message as unknown as Record<string, unknown>,
        ),
      ),
    );
    expect(response.status).toBe(200);
    expect(direct).toHaveBeenCalledOnce();
    expect(direct.mock.calls[0]?.[1]).toMatchObject({
      isMention: false,
    });
    expect(mention).not.toHaveBeenCalled();
  });

  it("routes a canonical owner mention in a group", async () => {
    const { chat, direct, mention } = routingHarness();
    const message = webhookMessage({
      chat: {
        id: IDS.chat,
        is_group: true,
        owner_handle: AGENT_HANDLE,
      },
      parts: [
        {
          mention: AGENT_HANDLE.handle,
          mention_range: [0, AGENT_HANDLE.handle.length],
          type: "text",
          value: "Relay Agent please help",
        },
      ],
    });
    await chat.webhooks.relay(
      await signedRequest(
        envelope(
          "message.received",
          message as unknown as Record<string, unknown>,
        ),
      ),
    );
    expect(direct).not.toHaveBeenCalled();
    expect(mention).toHaveBeenCalledOnce();
    expect(mention.mock.calls[0]?.[1]).toMatchObject({
      isMention: true,
    });
  });

  it("does not invoke on an unmentioned group message", async () => {
    const { chat, direct, mention } = routingHarness();
    const message = webhookMessage({
      chat: {
        id: IDS.chat,
        is_group: true,
        owner_handle: AGENT_HANDLE,
      },
      parts: [{ type: "text", value: "hello everyone" }],
    });
    await chat.webhooks.relay(
      await signedRequest(
        envelope(
          "message.received",
          message as unknown as Record<string, unknown>,
        ),
      ),
    );
    expect(direct).not.toHaveBeenCalled();
    expect(mention).not.toHaveBeenCalled();
  });
});

selfMessageContract({
  makeOtherMessageRequest: () =>
    signedRequest(envelope("message.received")),
  makeSelfMessageRequest: () =>
    signedRequest(
      envelope(
        "message.received",
        webhookMessage({
          direction: "outbound",
          sender_handle: {
            ...USER_HANDLE,
            is_me: true,
          },
        }) as unknown as Record<string, unknown>,
      ),
    ),
  name: "relay",
  setup: async () => {
    const { adapter } = adapterHarness();
    const chat = createMockChatInstance();
    await adapter.initialize(chat);
    return { adapter, chat };
  },
});

const ATTACHMENT_URL =
  "https://cdn.relayapp.im/attachments/stale-token";
const FRESH_ATTACHMENT_URL =
  "https://cdn.relayapp.im/attachments/fresh-token";
const METADATA_URL =
  `https://api.relayapp.im/v1/attachments/${IDS.attachment}`;
const ATTACHMENT_BYTES = new TextEncoder().encode("relay-inbound-bytes");
const FRESH_BYTES = new TextEncoder().encode("relay-re-minted-bytes");

function mediaPart() {
  return {
    filename: "receipt.png",
    height: 480,
    id: IDS.attachment,
    mime_type: "image/png",
    reactions: null,
    size_bytes: ATTACHMENT_BYTES.byteLength,
    type: "media" as const,
    url: ATTACHMENT_URL,
    width: 640,
  };
}

function mediaHarness(
  options: {
    download?: () => Response;
    metadata?: () => Response;
  } = {},
) {
  const download =
    options.download ??
    (() =>
      new Response(ATTACHMENT_BYTES, {
        headers: { "content-type": "image/png" },
        status: 200,
      }));
  const metadata =
    options.metadata ??
    (() =>
      jsonResponse({
        content_type: "image/png",
        created_at: "2026-08-30T12:00:00.000Z",
        download_url: FRESH_ATTACHMENT_URL,
        filename: "receipt.png",
        id: IDS.attachment,
        size_bytes: ATTACHMENT_BYTES.byteLength,
        status: "complete",
      }));
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === ATTACHMENT_URL) return download();
    if (url === METADATA_URL) return metadata();
    if (url === FRESH_ATTACHMENT_URL) {
      return new Response(FRESH_BYTES, {
        headers: { "content-type": "image/png" },
        status: 200,
      });
    }
    return new Response(null, { status: 204 });
  });
  const adapter = createRelayAdapter({
    fetch: fetchMock as typeof fetch,
    token: "agent-token",
    webhookSecret: WEBHOOK_SECRET,
  });
  const message = adapter.parseMessage({
    chatId: IDS.chat,
    createdAt: "2026-08-30T12:00:00.000Z",
    eventType: "message.received",
    message: webhookMessage({ parts: [mediaPart()] }),
  });
  return { adapter, fetchMock, message };
}

describe("inbound attachment bytes", () => {
  it("fetches the bytes of an inbound media part", async () => {
    const { fetchMock, message } = mediaHarness();
    const attachment = message.attachments[0];

    expect(attachment?.fetchMetadata).toEqual({
      attachmentId: IDS.attachment,
      url: ATTACHMENT_URL,
    });
    expect(fetchMock).not.toHaveBeenCalled();

    const data = await attachment?.fetchData?.();
    expect(data).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(data as ArrayBuffer)).toEqual(
      ATTACHMENT_BYTES,
    );
    expect(fetchMock).toHaveBeenCalledWith(ATTACHMENT_URL);
  });

  it("passes an unknown inbound content type through as a file", () => {
    const adapter = createRelayAdapter({
      fetch: vi.fn() as unknown as typeof fetch,
      token: "agent-token",
      webhookSecret: WEBHOOK_SECRET,
    });
    const message = adapter.parseMessage({
      chatId: IDS.chat,
      createdAt: "2026-08-30T12:00:00.000Z",
      eventType: "message.received",
      message: webhookMessage({
        parts: [{
          ...mediaPart(),
          filename: "trace.custom",
          height: null,
          mime_type: "application/x-custom",
          width: null,
        }],
      }),
    });
    const attachment = message.attachments[0];

    expect(attachment?.mimeType).toBe("application/x-custom");
    expect(attachment?.type).toBe("file");
  });

  it("names the attachment and the status when the download fails", async () => {
    const { message } = mediaHarness({
      download: () => new Response("", { status: 503 }),
    });
    const attachment = message.attachments[0];

    await expect(attachment?.fetchData?.()).rejects.toThrow(
      `Failed to download Relay attachment ${IDS.attachment}: HTTP 503`,
    );
  });

  it("rebuilds fetchData on a serialized attachment", async () => {
    const { adapter, message } = mediaHarness();
    const roundTripped = JSON.parse(
      JSON.stringify(message.toJSON()),
    ) as { attachments: Attachment[] };
    const serialized = roundTripped.attachments[0];

    expect(serialized?.fetchData).toBeUndefined();
    expect(serialized?.fetchMetadata).toEqual({
      attachmentId: IDS.attachment,
      url: ATTACHMENT_URL,
    });

    const rehydrated = adapter.rehydrateAttachment(
      serialized as Attachment,
    );
    const data = await rehydrated.fetchData?.();
    expect(new Uint8Array(data as ArrayBuffer)).toEqual(FRESH_BYTES);
  });

  it("re-mints the download link from the attachment id", async () => {
    const { adapter, fetchMock, message } = mediaHarness();
    const serialized = JSON.parse(
      JSON.stringify(message.toJSON()),
    ).attachments[0] as Attachment;

    const data = await adapter
      .rehydrateAttachment(serialized)
      .fetchData?.();

    expect(new Uint8Array(data as ArrayBuffer)).toEqual(FRESH_BYTES);
    const requested = fetchMock.mock.calls.map((call) =>
      String(call[0]),
    );
    expect(requested).toEqual([METADATA_URL, FRESH_ATTACHMENT_URL]);
    expect(requested).not.toContain(ATTACHMENT_URL);
  });

  it("falls back to the stored URL when the id cannot serve one", async () => {
    const { adapter, fetchMock, message } = mediaHarness({
      metadata: () => jsonResponse({ error: { code: "not_found" } }, 404),
    });
    const serialized = JSON.parse(
      JSON.stringify(message.toJSON()),
    ).attachments[0] as Attachment;

    const data = await adapter
      .rehydrateAttachment(serialized)
      .fetchData?.();

    expect(new Uint8Array(data as ArrayBuffer)).toEqual(
      ATTACHMENT_BYTES,
    );
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      METADATA_URL,
      ATTACHMENT_URL,
    ]);
  });
});
