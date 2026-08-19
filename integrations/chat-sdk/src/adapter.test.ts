import { createHmac } from "node:crypto";
import type { ChatInstance, Message } from "chat";
import { describe, expect, it, vi } from "vitest";
import { RelayAdapter, createRelayAdapter } from "./adapter.js";
import { RelayClient } from "./client.js";
import type { RelayEventEnvelope, RelayRawMessage } from "./types.js";

const SECRET_BYTES = Buffer.from("chat-sdk-adapter-test-secret");
const SECRET = `whsec_${SECRET_BYTES.toString("base64")}`;

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function harness(
  responses: Array<{ status?: number; body: unknown }> = [],
): {
  adapter: RelayAdapter;
  calls: RecordedCall[];
  chat: { messages: Array<Message<RelayRawMessage>>; deleted: string[]; updated: string[] };
} {
  const calls: RecordedCall[] = [];
  let index = 0;
  const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(
      (init?.headers ?? {}) as Record<string, string>,
    )) {
      headers[key.toLowerCase()] = value;
    }
    let body: unknown;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    } else {
      body = init?.body;
    }
    calls.push({ url: String(url), method: init?.method ?? "GET", headers, body });
    const next = responses[index++] ?? {
      body: {
        message_id: "msg_out",
        message: { id: "msg_out", conversation_id: "cnv_1" },
      },
    };
    const status = next.status ?? 200;
    // Relay answers 204 on the typing route, and a 204 carries no body.
    if (status === 204) return new Response(null, { status });
    return new Response(JSON.stringify(next.body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  });

  const adapter = createRelayAdapter({
    client: new RelayClient({ token: "rly_live_test", fetch: fetchMock as typeof fetch }),
    webhookSecret: SECRET,
    userName: "Test Agent",
  });

  const seen = {
    messages: [] as Array<Message<RelayRawMessage>>,
    deleted: [] as string[],
    updated: [] as string[],
  };
  const chat = {
    async processMessage(
      _adapter: unknown,
      _threadId: string,
      message: Message<RelayRawMessage> | (() => Promise<Message<RelayRawMessage>>),
    ) {
      seen.messages.push(
        typeof message === "function" ? await message() : message,
      );
    },
    async processMessageUpdated(event: { message: unknown }) {
      seen.updated.push((event.message as Message).id);
    },
    async processMessageDeleted(event: { messageId: string }) {
      seen.deleted.push(event.messageId);
    },
  };
  void adapter.initialize(chat as unknown as ChatInstance);
  return { adapter, calls, chat: seen };
}

function messageEvent(
  overrides: Partial<RelayEventEnvelope> = {},
  invocationId?: string,
): RelayEventEnvelope {
  return {
    event_id: "evt_01TEST",
    event_type: "message.received",
    agent_id: "agt_01TEST",
    created_at: "2026-08-19T00:00:00.000Z",
    data: {
      message: {
        id: "msg_01IN",
        conversation_id: "cnv_1",
        sequence: 7,
        sender: { kind: "user", id: "usr_01TEST" },
        is_from_me: false,
        status: "sent",
        parts: [{ part_index: 0, type: "text", text: "hello there" }],
        created_at: "2026-08-19T00:00:00.000Z",
      },
      ...(invocationId ? { invocation_id: invocationId } : {}),
    },
    ...overrides,
  };
}

function signedRequest(body: string, id = "whmsg_1", secret = SECRET_BYTES): Request {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const mac = createHmac("sha256", secret)
    .update(`${id}.${timestamp}.${body}`)
    .digest("base64");
  return new Request("https://agent.example.com/eve/v1/relay", {
    method: "POST",
    body,
    headers: {
      "webhook-id": id,
      "webhook-timestamp": timestamp,
      "webhook-signature": `v1,${mac}`,
    },
  });
}

describe("thread ids", () => {
  const adapter = createRelayAdapter({ token: "rly_live_test" });

  it("round trips a conversation id", () => {
    const threadId = adapter.encodeThreadId({ conversationId: "cnv_01ABC" });
    expect(threadId).toBe("relay:cnv_01ABC");
    expect(adapter.decodeThreadId(threadId)).toEqual({ conversationId: "cnv_01ABC" });
  });

  it("treats the conversation as its own channel", () => {
    expect(adapter.channelIdFromThreadId("relay:cnv_01ABC")).toBe("relay:cnv_01ABC");
  });

  it("refuses a thread id from another platform", () => {
    expect(() => adapter.decodeThreadId("slack:C123:1.2")).toThrow(
      /not a Relay thread id/,
    );
  });

  it("refuses a Relay prefix with no conversation", () => {
    expect(() => adapter.decodeThreadId("relay:")).toThrow(/no conversation id/);
  });
});

describe("handleWebhook", () => {
  it("accepts a valid signature and dispatches the message", async () => {
    const { adapter, chat } = harness();
    const body = JSON.stringify(messageEvent());
    const response = await adapter.handleWebhook(signedRequest(body));
    expect(response.status).toBe(200);
    expect(chat.messages).toHaveLength(1);
    expect(chat.messages[0]?.text).toBe("hello there");
    expect(chat.messages[0]?.threadId).toBe("relay:cnv_1");
    expect(chat.messages[0]?.isMention).toBe(true);
  });

  it("rejects a signature made with the wrong secret", async () => {
    const { adapter, chat } = harness();
    const body = JSON.stringify(messageEvent());
    const response = await adapter.handleWebhook(
      signedRequest(body, "whmsg_1", Buffer.from("the-wrong-secret")),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: "invalid_signature" },
    });
    expect(chat.messages).toHaveLength(0);
  });

  it("rejects a request with no signature headers", async () => {
    const { adapter } = harness();
    const response = await adapter.handleWebhook(
      new Request("https://agent.example.com/eve/v1/relay", {
        method: "POST",
        body: JSON.stringify(messageEvent()),
      }),
    );
    expect(response.status).toBe(401);
  });

  it("refuses anything but POST", async () => {
    const { adapter } = harness();
    const response = await adapter.handleWebhook(
      new Request("https://agent.example.com/eve/v1/relay", { method: "GET" }),
    );
    expect(response.status).toBe(405);
  });

  it("answers 422 on a body that is not an event envelope", async () => {
    const { adapter } = harness();
    const response = await adapter.handleWebhook(signedRequest("{}"));
    expect(response.status).toBe(422);
  });

  it("deduplicates a redelivered event_id", async () => {
    const { adapter, chat } = harness();
    const body = JSON.stringify(messageEvent());
    await adapter.handleWebhook(signedRequest(body, "whmsg_1"));
    const second = await adapter.handleWebhook(signedRequest(body, "whmsg_2"));
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ deduplicated: true });
    expect(chat.messages).toHaveLength(1);
  });

  it("dispatches an edit and an unsend to their own Chat SDK hooks", async () => {
    const { adapter, chat } = harness();
    const edited = messageEvent({ event_id: "evt_edit", event_type: "message.edited" });
    await adapter.handleWebhook(signedRequest(JSON.stringify(edited)));
    const unsent: RelayEventEnvelope = {
      event_id: "evt_unsent",
      event_type: "message.unsent",
      agent_id: "agt_01TEST",
      created_at: "2026-08-19T00:00:00.000Z",
      data: { message_id: "msg_01IN", conversation_id: "cnv_1", sequence: 7 },
    };
    await adapter.handleWebhook(signedRequest(JSON.stringify(unsent)));
    expect(chat.updated).toEqual(["msg_01IN"]);
    expect(chat.deleted).toEqual(["msg_01IN"]);
  });

  it("acknowledges an event type it does not map without dispatching", async () => {
    const { adapter, chat } = harness();
    const receipt: RelayEventEnvelope = {
      event_id: "evt_read",
      event_type: "message.read",
      agent_id: "agt_01TEST",
      created_at: "2026-08-19T00:00:00.000Z",
      data: {},
    };
    const response = await adapter.handleWebhook(signedRequest(JSON.stringify(receipt)));
    expect(response.status).toBe(200);
    expect(chat.messages).toHaveLength(0);
  });
});

describe("postMessage", () => {
  it("posts the OpenAPI payload shape with a keyed idempotent send", async () => {
    const { adapter, calls } = harness();
    await adapter.handleWebhook(signedRequest(JSON.stringify(messageEvent())));
    const sent = await adapter.postMessage("relay:cnv_1", { markdown: "**hi** there" });

    const post = calls.at(-1) as RecordedCall;
    expect(post.method).toBe("POST");
    expect(post.url).toBe("https://api.relayapp.im/v1/messages");
    expect(post.headers.authorization).toBe("Bearer rly_live_test");
    expect(post.headers["content-type"]).toBe("application/json");
    expect(post.headers["idempotency-key"]).toMatch(/^evt_01TEST:0:[0-9a-f]{32}$/);
    expect(post.body).toEqual({
      conversation_id: "cnv_1",
      parts: [
        {
          type: "text",
          text: "hi there",
          styles: [{ start: 0, length: 2, styles: ["bold"] }],
        },
      ],
    });
    expect(sent).toEqual({
      id: "msg_out",
      threadId: "relay:cnv_1",
      raw: { message: { id: "msg_out", conversation_id: "cnv_1" } },
    });
  });

  it("marks a verbatim string as structured plain text", async () => {
    const { adapter, calls } = harness();
    await adapter.postMessage("relay:cnv_1", "**as typed**");
    expect((calls.at(-1) as RecordedCall).body).toMatchObject({
      parts: [{ type: "text", text: "**as typed**", styles: [] }],
    });
  });

  it("threads a group invocation into the first reply and spends it once", async () => {
    const { adapter, calls } = harness();
    await adapter.handleWebhook(
      signedRequest(JSON.stringify(messageEvent({}, "ivk_01k1m4q9vn2r7t9b4c6qdh8xwy"))),
    );
    await adapter.postMessage("relay:cnv_1", "first");
    await adapter.postMessage("relay:cnv_1", "second");
    const [first, second] = calls;
    expect((first as RecordedCall).body).toMatchObject({
      invocation_id: "ivk_01k1m4q9vn2r7t9b4c6qdh8xwy",
    });
    expect((second as RecordedCall).body).not.toHaveProperty("invocation_id");
  });

  it("derives a fresh key when no inbound event caused the send", async () => {
    const { adapter, calls } = harness();
    await adapter.postMessage("relay:cnv_9", "proactive");
    expect((calls.at(-1) as RecordedCall).headers["idempotency-key"]).toMatch(
      /^relay:cnv_9:[0-9a-f-]{36}$/,
    );
  });

  it("splits a reply that needs more parts than one message holds", async () => {
    const { adapter, calls } = harness();
    const long = Array.from({ length: 40 }, (_, index) =>
      `${"word ".repeat(1700)}block ${index}`,
    ).join("\n\n");
    await adapter.postMessage("relay:cnv_1", long);
    const posts = calls.filter((call) => call.url.endsWith("/v1/messages"));
    expect(posts.length).toBeGreaterThan(1);
    for (const post of posts) {
      const parts = (post.body as { parts: unknown[] }).parts;
      expect(parts.length).toBeLessThanOrEqual(32);
    }
  });
});

describe("reactions, typing, and receipts", () => {
  it("sends a tapback by name on the reactions route", async () => {
    const { adapter, calls } = harness();
    await adapter.addReaction("relay:cnv_1", "msg_1", "👍");
    const call = calls.at(-1) as RecordedCall;
    expect(call.url).toBe("https://api.relayapp.im/v1/messages/msg_1/reactions");
    expect(call.body).toEqual({ operation: "add", type: "like" });
  });

  it("removes a reaction through the same route", async () => {
    const { adapter, calls } = harness();
    await adapter.removeReaction("relay:cnv_1", "msg_1", "🔥");
    expect((calls.at(-1) as RecordedCall).body).toEqual({
      operation: "remove",
      type: "emoji",
      emoji: "🔥",
    });
  });

  it("posts an ephemeral typing label bounded to 80 characters", async () => {
    const { adapter, calls } = harness([{ status: 204, body: {} }]);
    await adapter.startTyping("relay:cnv_1", "x".repeat(120));
    const call = calls.at(-1) as RecordedCall;
    expect(call.url).toBe("https://api.relayapp.im/v1/conversations/cnv_1/typing");
    expect((call.body as { label: string }).label).toHaveLength(80);
  });

  it("advances the read watermark without starting a response", async () => {
    const { adapter, calls } = harness();
    await adapter.markAsRead("relay:cnv_1", "msg_1");
    const call = calls.at(-1) as RecordedCall;
    expect(call.url).toBe("https://api.relayapp.im/v1/conversations/cnv_1/read");
    expect(call.body).toEqual({ message_id: "msg_1" });
  });
});

describe("history and threads", () => {
  it("returns a page in chronological order with a backward cursor", async () => {
    const { adapter, calls } = harness([
      {
        body: {
          messages: [
            {
              id: "msg_b",
              conversation_id: "cnv_1",
              sequence: 9,
              sender: { kind: "user", id: "usr_1" },
              status: "sent",
              parts: [{ part_index: 0, type: "text", text: "second" }],
              created_at: "2026-08-19T00:00:01.000Z",
            },
            {
              id: "msg_a",
              conversation_id: "cnv_1",
              sequence: 8,
              sender: { kind: "user", id: "usr_1" },
              status: "sent",
              parts: [{ part_index: 0, type: "text", text: "first" }],
              created_at: "2026-08-19T00:00:00.000Z",
            },
          ],
        },
      },
    ]);
    const result = await adapter.fetchMessages("relay:cnv_1", { limit: 2 });
    expect((calls[0] as RecordedCall).url).toBe(
      "https://api.relayapp.im/v1/conversations/cnv_1/messages?limit=2",
    );
    expect(result.messages.map((message) => message.text)).toEqual([
      "first",
      "second",
    ]);
    expect(result.nextCursor).toBe("8");
  });

  it("says plainly that Relay history has no forward cursor", async () => {
    const { adapter } = harness();
    await expect(
      adapter.fetchMessages("relay:cnv_1", { direction: "forward" }),
    ).rejects.toThrow(/pages backwards only/);
  });

  it("reports a direct conversation as a DM", async () => {
    const { adapter } = harness([
      {
        body: {
          conversation: {
            id: "cnv_1",
            kind: "direct",
            title: null,
            counterpart_user: {
              id: "usr_1",
              display_name: "Rushil",
              avatar_url: null,
            },
            participant_count: 2,
            last_sequence: 9,
            last_message_at: "2026-08-19T00:00:00.000Z",
            created_at: "2026-08-01T00:00:00.000Z",
          },
        },
      },
    ]);
    const info = await adapter.fetchThread("relay:cnv_1");
    expect(info).toMatchObject({
      id: "relay:cnv_1",
      channelId: "relay:cnv_1",
      isDM: true,
      channelName: "Rushil",
    });
  });

  it("resolves a user and reports an unknown one as null", async () => {
    const { adapter } = harness([
      {
        body: {
          user: {
            id: "usr_1",
            name: "Rushil Kagithala",
            first_name: "Rushil",
            last_name: "Kagithala",
            phone_number: "+13135550123",
            avatar_url: null,
            created_at: "2026-08-01T00:00:00.000Z",
          },
        },
      },
      { status: 404, body: { error: { code: "not_found", message: "no" } } },
    ]);
    expect(await adapter.getUser("usr_1")).toMatchObject({
      userId: "usr_1",
      fullName: "Rushil Kagithala",
      isBot: false,
    });
    expect(await adapter.getUser("usr_missing")).toBeNull();
  });
});

describe("stream", () => {
  it("buffers a streamed turn and commits exactly one message", async () => {
    const { adapter, calls } = harness();
    async function* chunks() {
      yield "Hello ";
      yield "from ";
      yield "Relay.";
    }
    const sent = await adapter.stream("relay:cnv_1", chunks());
    const posts = calls.filter((call) => call.url.endsWith("/v1/messages"));
    expect(posts).toHaveLength(1);
    expect((posts[0] as RecordedCall).body).toMatchObject({
      parts: [{ type: "text", text: "Hello from Relay." }],
    });
    expect(sent?.id).toBe("msg_out");
  });

  it("posts nothing for a stream that produced no text", async () => {
    const { adapter, calls } = harness();
    async function* empty() {
      // no chunks
    }
    expect(await adapter.stream("relay:cnv_1", empty())).toBeNull();
    expect(calls).toHaveLength(0);
  });
});
