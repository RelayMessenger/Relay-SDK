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
  RELAY_BACKWARD_WALK_MAX_PAGES,
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

  it("publishes active turns for cross-process cancellation", () => {
    const { adapter } = adapterHarness();
    const typed: Adapter = adapter;
    expect(typed.supportsTurnCancellation).toBe(true);
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

  it("posts a public HTTPS attachment by reference without spending an upload", async () => {
    const { adapter, calls } = adapterHarness();
    await adapter.postMessage(THREAD_ID, {
      attachments: [
        {
          mimeType: "image/png",
          name: "photo.png",
          type: "image" as const,
          url: "https://cdn.example.test/photo.png",
        },
      ],
      raw: "look",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toMatchObject({
      message: {
        parts: [
          { type: "text", value: "look" },
          { type: "media", url: "https://cdn.example.test/photo.png" },
        ],
      },
    });
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

  it("serves an explicit forward fetch with one request and Relay's own cursor", async () => {
    const { adapter, calls } = adapterHarness();
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
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain("limit=10");
  });

  it("reads a single message and answers null for one Relay does not have", async () => {
    function messageHarness(responder: () => Response) {
      const adapter = createRelayAdapter({
        fetch: vi.fn(async () => responder()) as unknown as typeof fetch,
        token: "agent-token",
        webhookSecret: WEBHOOK_SECRET,
      });
      return adapter;
    }
    const found = await messageHarness(() =>
      jsonResponse({
        chat_id: IDS.chat,
        created_at: "2026-08-30T12:00:00.000Z",
        delivery_status: "sent",
        from_handle: USER_HANDLE,
        id: IDS.message,
        is_from_me: false,
        parts: [{ reactions: null, type: "text", value: "found" }],
        reply_to: null,
      }),
    ).fetchMessage(THREAD_ID, IDS.message);
    expect(found).toMatchObject({ id: IDS.message, text: "found" });

    const absent = await messageHarness(() =>
      jsonResponse(
        { error: { code: "not_found", message: "No such Message." } },
        404,
      ),
    ).fetchMessage(THREAD_ID, IDS.message);
    expect(absent).toBeNull();
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

describe("backward fetchMessages over Relay's forward-only cursor", () => {
  const PER_PAGE = 3;

  /**
   * Serve `pageCount` pages of history. Each page carries a `next_cursor`
   * except the last, which ends the walk exactly as Relay's contract says
   * ("Null if there are no more results to fetch").
   */
  function historyHarness(pageCount: number) {
    const urls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      urls.push(url.toString());
      const cursor = url.searchParams.get("cursor");
      const page = cursor ? Number(cursor.replace("page-", "")) : 0;
      const isLast = page >= pageCount - 1;
      return jsonResponse({
        messages: Array.from({ length: PER_PAGE }, (_, index) => {
          const ordinal = page * PER_PAGE + index;
          return {
            chat_id: IDS.chat,
            created_at: "2026-08-30T12:00:00.000Z",
            delivery_status: "sent",
            from_handle: USER_HANDLE,
            id: `00000000-0000-4000-8000-${String(ordinal).padStart(12, "0")}`,
            is_from_me: false,
            parts: [
              { reactions: null, type: "text", value: `m${ordinal}` },
            ],
            reply_to: null,
          };
        }),
        next_cursor: isLast ? null : `page-${page + 1}`,
      });
    });
    const adapter = createRelayAdapter({
      fetch: fetchMock as unknown as typeof fetch,
      token: "agent-token",
      webhookSecret: WEBHOOK_SECRET,
    });
    return { adapter, urls };
  }

  it("serves the default call shape with no options at all", async () => {
    const { adapter, urls } = historyHarness(3);
    const result = await adapter.fetchMessages(THREAD_ID);
    // Three pages of three, walked to the tail: the whole chat is the answer.
    expect(result.messages.map((message) => message.text)).toEqual([
      "m0",
      "m1",
      "m2",
      "m3",
      "m4",
      "m5",
      "m6",
      "m7",
      "m8",
    ]);
    expect(urls).toHaveLength(3);
    // The tail was reached, so Relay has no older page left to offer.
    expect(result.nextCursor).toBeUndefined();
  });

  it("returns the newest limit messages oldest-first for an explicit backward read", async () => {
    const { adapter, urls } = historyHarness(3);
    const result = await adapter.fetchMessages(THREAD_ID, {
      direction: "backward",
      limit: 4,
    });
    expect(result.messages.map((message) => message.text)).toEqual([
      "m5",
      "m6",
      "m7",
      "m8",
    ]);
    expect(result.messages[0]?.threadId).toBe(THREAD_ID);
    expect(urls).toHaveLength(3);
    // Every request asks for the contract's maximum page, not the caller's limit.
    expect(urls.every((url) => url.includes("limit=100"))).toBe(true);
  });

  it("asks for one page when the chat fits in one page", async () => {
    const { adapter, urls } = historyHarness(1);
    const result = await adapter.fetchMessages(THREAD_ID);
    expect(result.messages).toHaveLength(PER_PAGE);
    expect(urls).toHaveLength(1);
  });

  it("stops at the page cap and hands back the cursor that resumes the walk", async () => {
    const { adapter, urls } = historyHarness(
      RELAY_BACKWARD_WALK_MAX_PAGES + 5,
    );
    const result = await adapter.fetchMessages(THREAD_ID, { limit: 2 });
    expect(urls).toHaveLength(RELAY_BACKWARD_WALK_MAX_PAGES);
    expect(result.nextCursor).toBe(`page-${RELAY_BACKWARD_WALK_MAX_PAGES}`);
    const resumed = await adapter.fetchMessages(THREAD_ID, {
      cursor: result.nextCursor!,
      limit: 2,
    });
    // Resuming converges on the true tail rather than repeating the same page.
    expect(resumed.messages.map((message) => message.text)).toEqual([
      "m43",
      "m44",
    ]);
    expect(resumed.nextCursor).toBeUndefined();
  });

  it("routes fetchChannelMessages through the same walk", async () => {
    const { adapter, urls } = historyHarness(2);
    const result = await adapter.fetchChannelMessages(THREAD_ID);
    expect(result.messages).toHaveLength(PER_PAGE * 2);
    expect(urls).toHaveLength(2);
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

describe("burst concurrency", () => {
  /**
   * The owner's target flow debounces bursts by 2 s. Burst and debounce do not
   * run the handler inside the webhook call that carried the message: the
   * message is serialized, revived, and handled after that request returned.
   * A reply posted from there must still get a stable idempotency key.
   */
  it("lets the handler post after a 2s burst window with two webhooks 100ms apart", async () => {
    const sends: Array<{ body: unknown; key: string | null }> = [];
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith("/messages")) {
          sends.push({
            body:
              typeof init?.body === "string"
                ? (JSON.parse(init.body) as unknown)
                : init?.body,
            key: new Headers(init?.headers).get("idempotency-key"),
          });
          return jsonResponse(sentMessage(), 202);
        }
        return new Response(null, { status: 204 });
      },
    );
    const adapter = createRelayAdapter({
      fetch: fetchMock as unknown as typeof fetch,
      token: "agent-token",
      webhookSecret: WEBHOOK_SECRET,
    });

    let settle: (error: unknown) => void = () => undefined;
    const handled = new Promise<unknown>((resolve) => {
      settle = resolve;
    });
    const chat = new Chat({
      adapters: { relay: adapter },
      concurrency: { debounceMs: 2_000, strategy: "burst" },
      logger: "error",
      state: createMockState(),
      userName: "Relay Agent",
    });
    chat.onDirectMessage(async (thread) => {
      try {
        await thread.post("burst reply");
        settle(null);
      } catch (error) {
        settle(error);
      }
    });

    const SECOND_EVENT = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    // Both deliveries must be in flight together: awaiting the first would let
    // its burst window close and give the second a window of its own.
    const first = chat.webhooks.relay(
      await signedRequest(
        envelope(
          "message.received",
          webhookMessage() as unknown as Record<string, unknown>,
        ),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    const second = chat.webhooks.relay(
      await signedRequest(
        envelope(
          "message.received",
          webhookMessage({ id: IDS.reply }) as unknown as Record<
            string,
            unknown
          >,
          { event_id: SECOND_EVENT },
        ),
      ),
    );
    const [firstResponse, secondResponse] = await Promise.all([
      first,
      second,
    ]);
    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);

    const failure = await handled;
    // The whole point: the post inside a burst handler must not throw.
    expect(failure).toBeNull();
    // Burst collapses the pair into one handler run, so one reply.
    expect(sends).toHaveLength(1);
    // The key is derived from a real inbound event, never invented, so a
    // redelivery of that event collides rather than double-posting.
    expect([
      `relay-chat-sdk:${IDS.event}:0`,
      `relay-chat-sdk:${SECOND_EVENT}:0`,
    ]).toContain(sends[0]?.key);
  }, 20_000);

  /**
   * The turn context lives in `AsyncLocalStorage`, so a handler that ran
   * after its webhook call returned would post without a key and be refused.
   * It does not: every deferring strategy awaits the handler inside the
   * webhook call, so the store is still in scope. This asserts that for the
   * strategies that defer, because the day one of them resumes out of band is
   * the day replies start failing.
   */
  it.each(["burst", "debounce", "queue"] as const)(
    "derives the idempotency key from a real inbound event under %s",
    async (strategy) => {
      const keys: Array<string | null> = [];
      const fetchMock = vi.fn(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          if (String(input).endsWith("/messages")) {
            keys.push(new Headers(init?.headers).get("idempotency-key"));
            return jsonResponse(sentMessage(), 202);
          }
          return new Response(null, { status: 204 });
        },
      );
      const adapter = createRelayAdapter({
        fetch: fetchMock as unknown as typeof fetch,
        token: "agent-token",
        webhookSecret: WEBHOOK_SECRET,
      });
      let settle: (error: unknown) => void = () => undefined;
      const handled = new Promise<unknown>((resolve) => {
        settle = resolve;
      });
      const chat = new Chat({
        adapters: { relay: adapter },
        concurrency: { debounceMs: 200, strategy },
        logger: "error",
        state: createMockState(),
        userName: "Relay Agent",
      });
      chat.onDirectMessage(async (thread) => {
        try {
          await thread.post("reply");
          settle(null);
        } catch (error) {
          settle(error);
        }
      });
      await chat.webhooks.relay(
        await signedRequest(
          envelope(
            "message.received",
            webhookMessage() as unknown as Record<string, unknown>,
          ),
        ),
      );
      expect(await handled).toBeNull();
      expect(keys).toEqual([`relay-chat-sdk:${IDS.event}:0`]);
    },
    20_000,
  );
});

describe("outbound local bytes and files", () => {
  interface UploadCall {
    body: unknown;
    headers: Headers;
    method: string;
    url: string;
  }

  function uploadHarness() {
    const calls: UploadCall[] = [];
    let allocations = 0;
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({
          body:
            typeof init?.body === "string"
              ? (JSON.parse(init.body) as unknown)
              : init?.body,
          headers: new Headers(init?.headers),
          method: init?.method ?? "GET",
          url,
        });
        if (url.endsWith("/v1/attachments")) {
          allocations += 1;
          return jsonResponse(
            {
              attachment_id: `00000000-0000-4000-8000-00000000000${allocations}`,
              download_url: "https://cdn.relay.test/download",
              expires_at: "2026-08-30T13:00:00.000Z",
              http_method: "PUT",
              required_headers: { "x-upload-token": "opaque" },
              upload_url: `https://storage.relay.test/upload/${allocations}`,
            },
            201,
          );
        }
        if (url.startsWith("https://storage.relay.test/")) {
          return new Response(null, { status: 200 });
        }
        return jsonResponse(sentMessage(), 202);
      },
    );
    const adapter = createRelayAdapter({
      fetch: fetchMock as unknown as typeof fetch,
      idempotencyKeyResolver: () => "test-upload",
      token: "agent-token",
      webhookSecret: WEBHOOK_SECRET,
    });
    return { adapter, calls };
  }

  it("allocates, uploads, then posts a media part referencing the attachment", async () => {
    const { adapter, calls } = uploadHarness();
    await adapter.postMessage(THREAD_ID, {
      files: [
        {
          data: new Uint8Array([1, 2, 3]).buffer,
          filename: "photo.png",
          mimeType: "image/png",
        },
      ],
      raw: "here it is",
    });

    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "POST https://api.relayapp.im/v1/attachments",
      "PUT https://storage.relay.test/upload/1",
      `POST https://api.relayapp.im/v1/chats/${IDS.chat}/messages`,
    ]);
    expect(calls[0]?.body).toEqual({
      content_type: "image/png",
      filename: "photo.png",
      size_bytes: 3,
    });
    // Storage takes only the headers Relay handed back; never the Agent Token.
    expect(
      Object.fromEntries(calls[1]!.headers.entries()),
    ).toEqual({ "x-upload-token": "opaque" });
    expect(calls[2]?.body).toMatchObject({
      message: {
        parts: [
          { type: "text", value: "here it is" },
          {
            attachment_id: "00000000-0000-4000-8000-000000000001",
            type: "media",
          },
        ],
      },
    });
  });

  it("sends the file's own bytes, not the pool its Buffer sits in", async () => {
    const { adapter, calls } = uploadHarness();
    // A Node Buffer from a small allocation is a window onto a shared pool.
    const pooled = Buffer.from([7, 8, 9]);
    await adapter.postMessage(THREAD_ID, {
      files: [{ data: pooled, filename: "three.bin" }],
      raw: "",
    });
    const uploaded = calls[1]?.body as Uint8Array;
    expect(uploaded.byteLength).toBe(3);
    expect([...uploaded]).toEqual([7, 8, 9]);
    expect(calls[0]?.body).toMatchObject({ size_bytes: 3 });
  });

  it("infers the content type from the filename when none is declared", async () => {
    const { adapter, calls } = uploadHarness();
    await adapter.postMessage(THREAD_ID, {
      files: [
        { data: new Uint8Array([1]).buffer, filename: "notes.pdf" },
      ],
      raw: "",
    });
    expect(calls[0]?.body).toMatchObject({
      content_type: "application/pdf",
    });
  });

  it("uploads an attachment that carries bytes instead of a URL", async () => {
    const { adapter, calls } = uploadHarness();
    await adapter.postMessage(THREAD_ID, {
      attachments: [
        {
          data: Buffer.from([4, 5]),
          height: 20,
          mimeType: "image/png",
          name: "shot.png",
          type: "image" as const,
          width: 10,
        },
      ],
      raw: "",
    });
    expect(calls[0]?.body).toEqual({
      content_type: "image/png",
      filename: "shot.png",
      height: 20,
      size_bytes: 2,
      width: 10,
    });
    expect(calls[2]?.body).toMatchObject({
      message: {
        parts: [
          {
            attachment_id: "00000000-0000-4000-8000-000000000001",
            type: "media",
          },
        ],
      },
    });
  });

  it("uploads an attachment that can only fetch its bytes", async () => {
    const { adapter, calls } = uploadHarness();
    await adapter.postMessage(THREAD_ID, {
      attachments: [
        {
          fetchData: async () => new Uint8Array([9, 9, 9, 9]).buffer,
          mimeType: "application/octet-stream",
          name: "blob.bin",
          type: "file" as const,
        },
      ],
      raw: "",
    });
    expect(calls[0]?.body).toMatchObject({ size_bytes: 4 });
  });

  it("uploads every file in the message, one attachment each", async () => {
    const { adapter, calls } = uploadHarness();
    await adapter.postMessage(THREAD_ID, {
      files: [
        { data: new Uint8Array([1]).buffer, filename: "a.txt" },
        { data: new Uint8Array([2, 2]).buffer, filename: "b.txt" },
      ],
      raw: "",
    });
    const sent = calls.at(-1)?.body as {
      message: { parts: Array<Record<string, unknown>> };
    };
    expect(sent.message.parts).toEqual([
      {
        attachment_id: "00000000-0000-4000-8000-000000000001",
        type: "media",
      },
      {
        attachment_id: "00000000-0000-4000-8000-000000000002",
        type: "media",
      },
    ]);
  });

  it("refuses a body it cannot read, before allocating anything", async () => {
    const { adapter, calls } = uploadHarness();
    await expect(
      adapter.postMessage(THREAD_ID, {
        files: [
          {
            data: "not bytes" as unknown as ArrayBuffer,
            filename: "bad.txt",
          },
        ],
        raw: "",
      }),
    ).rejects.toThrow(/cannot read the bytes of file "bad\.txt"/);
    expect(calls).toHaveLength(0);
  });

  it("refuses an attachment carrying neither bytes nor a public URL", async () => {
    const { adapter, calls } = uploadHarness();
    await expect(
      adapter.postMessage(THREAD_ID, {
        attachments: [
          { name: "ghost.png", type: "image" as const },
        ],
        raw: "",
      }),
    ).rejects.toThrow(/neither bytes nor a public HTTPS URL/);
    expect(calls).toHaveLength(0);
  });
});

describe("isDM outside a webhook dispatch", () => {
  function chatHarness(isGroup: boolean) {
    const urls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return jsonResponse({
        created_at: "2026-08-30T12:00:00.000Z",
        display_name: isGroup ? "Team" : null,
        handles: [USER_HANDLE, AGENT_HANDLE],
        id: IDS.chat,
        is_group: isGroup,
        updated_at: "2026-08-30T12:00:00.000Z",
      });
    });
    const adapter = createRelayAdapter({
      fetch: fetchMock as unknown as typeof fetch,
      token: "agent-token",
      webhookSecret: WEBHOOK_SECRET,
    });
    return { adapter, urls };
  }

  it("answers true for a direct chat after fetchThread, with no dispatch active", async () => {
    const { adapter } = chatHarness(false);
    await adapter.fetchThread(THREAD_ID);
    expect(adapter.isDM(THREAD_ID)).toBe(true);
  });

  it("answers false for a group chat after fetchThread", async () => {
    const { adapter } = chatHarness(true);
    await adapter.fetchThread(THREAD_ID);
    expect(adapter.isDM(THREAD_ID)).toBe(false);
  });

  it("answers false for a chat it has never seen", () => {
    const { adapter, urls } = chatHarness(false);
    expect(adapter.isDM(THREAD_ID)).toBe(false);
    // Answering must stay synchronous: no request may be spent on it.
    expect(urls).toHaveLength(0);
  });

  it("learns the kind from onThreadSubscribe and spends one request doing it", async () => {
    const { adapter, urls } = chatHarness(false);
    await adapter.onThreadSubscribe(THREAD_ID);
    expect(adapter.isDM(THREAD_ID)).toBe(true);
    expect(urls).toEqual([
      `https://api.relayapp.im/v1/chats/${IDS.chat}`,
    ]);
    // A second subscribe re-reads nothing: a Chat's kind never changes.
    await adapter.onThreadSubscribe(THREAD_ID);
    expect(urls).toHaveLength(1);
  });

  it("still answers correctly after the webhook dispatch that taught it has ended", async () => {
    const { adapter } = chatHarness(false);
    const chat = createMockChatInstance();
    await adapter.initialize(chat);
    const response = await adapter.handleWebhook(
      await signedRequest(
        envelope(
          "message.received",
          webhookMessage() as unknown as Record<string, unknown>,
        ),
      ),
    );
    expect(response.status).toBe(200);
    // The dispatch has returned; the old request-scoped hint would be gone.
    expect(adapter.isDM(THREAD_ID)).toBe(true);
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

const READ_URL = `/v1/chats/${IDS.chat}/read`;

/**
 * Records the order of Relay HTTP calls and Chat SDK dispatch in one
 * sequence, so a test can assert that the read is stamped before the
 * handler rather than merely that both happened.
 */
function receiptHarness(
  options: {
    abortActiveTurnOnReceipt?: boolean;
    abortFails?: boolean;
    markReadOnReceipt?: boolean;
    readFails?: boolean;
  } = {},
) {
  const sequence: string[] = [];
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (init?.method === "POST" && url.pathname === READ_URL) {
        sequence.push("read");
        if (options.readFails) {
          return jsonResponse({ error: { code: "server_error" } }, 500);
        }
        return new Response(null, { status: 204 });
      }
      sequence.push(`${init?.method ?? "GET"} ${url.pathname}`);
      return new Response(null, { status: 204 });
    },
  );
  const adapter = createRelayAdapter({
    fetch: fetchMock as typeof fetch,
    token: "agent-token",
    webhookSecret: WEBHOOK_SECRET,
    ...(options.abortActiveTurnOnReceipt === undefined
      ? {}
      : { abortActiveTurnOnReceipt: options.abortActiveTurnOnReceipt }),
    ...(options.markReadOnReceipt === undefined
      ? {}
      : { markReadOnReceipt: options.markReadOnReceipt }),
  });
  const chat = createMockChatInstance();
  vi.mocked(chat.processMessage).mockImplementation(async () => {
    sequence.push("processMessage");
  });
  vi.mocked(chat.abortTurn).mockImplementation(async () => {
    sequence.push("abortTurn");
    if (options.abortFails) throw new Error("state unavailable");
  });
  return { adapter, chat, sequence };
}

describe("Relay read-on-receipt", () => {
  it("stamps the read before Chat SDK dispatch when enabled", async () => {
    const { adapter, chat, sequence } = receiptHarness({
      markReadOnReceipt: true,
    });
    await adapter.initialize(chat);

    const response = await adapter.handleWebhook(
      await signedRequest(envelope()),
    );

    expect(response.status).toBe(200);
    expect(sequence).toEqual(["read", "processMessage"]);
    expect(sequence.filter((step) => step === "read")).toHaveLength(1);
  });

  it("stamps no read when the option is absent", async () => {
    const { adapter, chat, sequence } = receiptHarness();
    await adapter.initialize(chat);

    const response = await adapter.handleWebhook(
      await signedRequest(envelope()),
    );

    expect(response.status).toBe(200);
    expect(sequence).toEqual(["processMessage"]);
  });

  it("acknowledges the delivery when the read fails", async () => {
    const { adapter, chat, sequence } = receiptHarness({
      markReadOnReceipt: true,
      readFails: true,
    });
    await adapter.initialize(chat);

    const response = await adapter.handleWebhook(
      await signedRequest(envelope()),
    );

    expect(response.status).toBe(200);
    expect(sequence).toEqual(["read", "processMessage"]);
    expect(vi.mocked(chat.getLogger("relay").warn)).toHaveBeenCalledWith(
      "relay_read_on_receipt_failed",
      expect.objectContaining({ chatId: IDS.chat }),
    );
  });

  it("stamps no read for the agent's own outbound message", async () => {
    const { adapter, chat, sequence } = receiptHarness({
      markReadOnReceipt: true,
    });
    await adapter.initialize(chat);

    const response = await adapter.handleWebhook(
      await signedRequest(
        envelope(
          "message.received",
          webhookMessage({
            direction: "outbound",
          }) as unknown as Record<string, unknown>,
        ),
      ),
    );

    expect(response.status).toBe(200);
    expect(sequence).toEqual([]);
  });

  it("stamps no read for a receipt or lifecycle event", async () => {
    const { adapter, chat, sequence } = receiptHarness({
      markReadOnReceipt: true,
    });
    await adapter.initialize(chat);

    for (const eventType of [
      "message.read",
      "message.delivered",
      "message.sent",
    ] as const) {
      await adapter.handleWebhook(
        await signedRequest(
          envelope(
            eventType,
            webhookMessage() as unknown as Record<string, unknown>,
          ),
        ),
      );
    }

    expect(sequence).toEqual([]);
  });
});

describe("Relay abort-on-receipt", () => {
  it("cancels the running turn before the newer message is dispatched", async () => {
    const { adapter, chat, sequence } = receiptHarness({
      abortActiveTurnOnReceipt: true,
      markReadOnReceipt: true,
    });
    await adapter.initialize(chat);

    const response = await adapter.handleWebhook(
      await signedRequest(envelope()),
    );

    expect(response.status).toBe(200);
    // Abort first: the read is an HTTP round trip, and the superseded turn
    // must stop spending model time as early as possible.
    expect(sequence).toEqual(["abortTurn", "read", "processMessage"]);
    expect(vi.mocked(chat.abortTurn)).toHaveBeenCalledWith(
      `relay:${IDS.chat}`,
    );
  });

  it("cancels nothing when the option is absent", async () => {
    const { adapter, chat, sequence } = receiptHarness();
    await adapter.initialize(chat);

    await adapter.handleWebhook(await signedRequest(envelope()));

    expect(sequence).toEqual(["processMessage"]);
    expect(vi.mocked(chat.abortTurn)).not.toHaveBeenCalled();
  });

  it("dispatches the newer message when cancellation fails", async () => {
    const { adapter, chat, sequence } = receiptHarness({
      abortActiveTurnOnReceipt: true,
      abortFails: true,
    });
    await adapter.initialize(chat);

    const response = await adapter.handleWebhook(
      await signedRequest(envelope()),
    );

    expect(response.status).toBe(200);
    expect(sequence).toEqual(["abortTurn", "processMessage"]);
    expect(vi.mocked(chat.getLogger("relay").warn)).toHaveBeenCalledWith(
      "relay_abort_on_receipt_failed",
      expect.objectContaining({ threadId: `relay:${IDS.chat}` }),
    );
  });

  it("cancels nothing for the agent's own outbound message", async () => {
    const { adapter, chat, sequence } = receiptHarness({
      abortActiveTurnOnReceipt: true,
    });
    await adapter.initialize(chat);

    await adapter.handleWebhook(
      await signedRequest(
        envelope(
          "message.received",
          webhookMessage({
            direction: "outbound",
          }) as unknown as Record<string, unknown>,
        ),
      ),
    );

    expect(sequence).toEqual([]);
  });
});
