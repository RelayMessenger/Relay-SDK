import { createHmac } from "node:crypto";
import type { ChatInstance, Message } from "chat";
import { describe, expect, it, vi } from "vitest";
import { RelayAdapter, createRelayAdapter } from "./adapter.js";
import { RelayClient } from "./client.js";
import { WebhookSecretError } from "./signature.js";
import type { RelayEventEnvelope, RelayPart, RelayRawMessage } from "./types.js";

const SECRET_BYTES = Buffer.from("chat-sdk-adapter-test-secret");
const SECRET = `whsec_${SECRET_BYTES.toString("base64")}`;

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * A handler that replies from inside `processMessage`, the way a real one
 * does. Several assertions below only hold for a reply made during a dispatch.
 */
type OnMessage = (
  threadId: string,
  message: Message<RelayRawMessage>,
) => Promise<void>;

function harness(
  responses: Array<{ status?: number; body: unknown }> = [],
  onMessage?: OnMessage,
): {
  adapter: RelayAdapter;
  calls: RecordedCall[];
  chat: { messages: Array<Message<RelayRawMessage>> };
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

  const seen = { messages: [] as Array<Message<RelayRawMessage>> };
  const chat = {
    async processMessage(
      _adapter: unknown,
      threadId: string,
      message: Message<RelayRawMessage> | (() => Promise<Message<RelayRawMessage>>),
    ) {
      const resolved = typeof message === "function" ? await message() : message;
      seen.messages.push(resolved);
      if (onMessage) await onMessage(threadId, resolved);
    },
  };
  void adapter.initialize(chat as unknown as ChatInstance);
  return { adapter, calls, chat: seen };
}

function messageEvent(
  overrides: Partial<RelayEventEnvelope> = {},
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
        kind: "message",
        sender: { kind: "user", id: "usr_01TEST" },
        is_from_me: false,
        status: "sent",
        parts: [
          { part_id: "prt_01IN", part_index: 0, type: "text", text: "hello there" },
        ],
        created_at: "2026-08-19T00:00:00.000Z",
      },
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

  it("claims the event id before dispatching, so two concurrent redeliveries cannot both run", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let dispatched: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      dispatched = resolve;
    });
    let dispatches = 0;
    const { adapter, chat } = harness([], async () => {
      dispatches += 1;
      dispatched?.();
      // A second dispatch is the defect under test. Let it through rather than
      // deadlocking on the gate, so the failure lands on the assertion below
      // instead of on the suite timeout.
      if (dispatches > 1) release?.();
      await gate;
    });
    const body = JSON.stringify(messageEvent());
    // The second delivery must arrive while the first is still inside its
    // handler, which is what a redelivery racing its original looks like.
    // Waiting on `entered` rather than on a timer pins that ordering: both
    // requests await an async signature check first, and whichever resolves
    // sooner takes the claim, so a bare `Promise.all` decides the winner by
    // scheduler luck. A check that only records on the way out still fails
    // here, because the first handler has not returned yet.
    const first = adapter.handleWebhook(signedRequest(body, "whmsg_1"));
    await entered;
    const second = await adapter.handleWebhook(signedRequest(body, "whmsg_2"));
    release?.();
    await first;
    expect(await second.json()).toEqual({ deduplicated: true });
    expect(chat.messages).toHaveLength(1);
  });

  it("releases the claim when the handler throws, so Relay's redelivery is handled", async () => {
    let attempts = 0;
    const { adapter, chat } = harness([], async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("handler blew up");
    });
    const body = JSON.stringify(messageEvent());
    await expect(adapter.handleWebhook(signedRequest(body, "whmsg_1"))).rejects.toThrow(
      /handler blew up/,
    );
    const retry = await adapter.handleWebhook(signedRequest(body, "whmsg_2"));
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ handled: true });
    expect(chat.messages).toHaveLength(2);
  });

  it("refuses a signing secret that is not base64, at construction", () => {
    expect(() =>
      createRelayAdapter({ token: "rly_live_test", webhookSecret: "whsec_!!not base64!!" }),
    ).toThrow(WebhookSecretError);
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

describe("parseMessage", () => {
  const adapter = createRelayAdapter({ token: "rly_live_test" });

  interface MdastNode {
    type: string;
    value?: string;
    children?: MdastNode[];
  }

  function textOf(node: MdastNode): string {
    if (typeof node.value === "string") return node.value;
    return (node.children ?? []).map(textOf).join("");
  }

  function runsOfType(node: unknown, type: string): string[] {
    const found: string[] = [];
    const walk = (current: MdastNode): void => {
      if (current.type === type) found.push(textOf(current));
      for (const child of current.children ?? []) walk(child);
    };
    walk(node as MdastNode);
    return found;
  }

  function inbound(parts: RelayPart[], fallbackText?: string): RelayRawMessage {
    return {
      message: {
        id: "msg_1",
        conversation_id: "cnv_1",
        sequence: 1,
        kind: "message",
        sender: { kind: "user", id: "usr_1" },
        status: "sent",
        parts,
        ...(fallbackText ? { fallback_text: fallbackText } : {}),
        created_at: "2026-08-19T00:00:00.000Z",
      },
    };
  }

  it("joins several text parts and rebases every style range onto the join", () => {
    // This is what a chunked reply looks like coming back, so reading only the
    // first part's ranges would flatten the formatting of everything after it.
    const message = adapter.parseMessage(
      inbound([
        {
          part_id: "prt_0",
          part_index: 0,
          type: "text",
          text: "alpha bravo",
          styles: [{ start: 6, length: 5, styles: ["bold"] }],
        },
        {
          part_id: "prt_1",
          part_index: 1,
          type: "text",
          text: "charlie delta",
          styles: [{ start: 0, length: 7, styles: ["italic"] }],
        },
      ]),
    );
    expect(message.text).toBe("alpha bravo\n\ncharlie delta");
    expect(runsOfType(message.formatted, "strong")).toEqual(["bravo"]);
    expect(runsOfType(message.formatted, "emphasis")).toEqual(["charlie"]);
  });

  it("skips an empty part rather than shifting the ranges after it", () => {
    const message = adapter.parseMessage(
      inbound([
        { part_id: "prt_0", part_index: 0, type: "text", text: "" },
        {
          part_id: "prt_1",
          part_index: 1,
          type: "text",
          text: "alpha bravo",
          styles: [{ start: 6, length: 5, styles: ["bold"] }],
        },
      ]),
    );
    expect(message.text).toBe("alpha bravo");
    expect(runsOfType(message.formatted, "strong")).toEqual(["bravo"]);
  });

  it("never applies a part's ranges to the fallback text that replaced it", () => {
    const message = adapter.parseMessage(
      inbound(
        [
          {
            part_id: "prt_0",
            part_index: 0,
            type: "text",
            text: "",
            styles: [{ start: 0, length: 5, styles: ["bold"] }],
          },
        ],
        "sent a photo",
      ),
    );
    expect(message.text).toBe("sent a photo");
    expect(runsOfType(message.formatted, "strong")).toEqual([]);
  });
});

describe("postMessage", () => {
  it("posts the OpenAPI payload shape with a client-minted message id", async () => {
    let sent: unknown;
    let adapter!: RelayAdapter;
    const built = harness([], async (threadId) => {
      sent = await adapter.postMessage(threadId, { markdown: "**hi** there" });
    });
    adapter = built.adapter;
    const calls = built.calls;
    await adapter.handleWebhook(signedRequest(JSON.stringify(messageEvent())));

    const post = calls.at(-1) as RecordedCall;
    expect(post.method).toBe("POST");
    expect(post.url).toBe("https://api.relayapp.im/v1/messages");
    expect(post.headers.authorization).toBe("Bearer rly_live_test");
    expect(post.headers["content-type"]).toBe("application/json");
    // The minted id is the only retry key; there is no idempotency header.
    expect(post.headers["idempotency-key"]).toBeUndefined();
    const body = post.body as { message_id: string };
    expect(body.message_id).toMatch(/^msg_[0-9a-hjkmnp-tv-z]{26}$/);
    expect(post.body).toMatchObject({
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

  it("throws on a 202 that carried no message instead of returning undefined", async () => {
    const { adapter } = harness([{ status: 202, body: {} }]);
    await expect(
      adapter.postMessage("relay:cnv_1", "hello"),
    ).rejects.toThrow(/carried no committed message/);
  });

  it("says plainly that Relay messages cannot be edited or unsent", async () => {
    const { adapter, calls } = harness();
    await expect(
      adapter.editMessage("relay:cnv_1", "msg_1", "shorter"),
    ).rejects.toThrow(/immutable/);
    await expect(adapter.deleteMessage("relay:cnv_1", "msg_1")).rejects.toThrow(
      /immutable/,
    );
    expect(calls).toHaveLength(0);
  });

  it("anchors a media reaction on its part when asked", async () => {
    // The adapter's Chat SDK surface is message-level, so the part anchor is
    // a client capability: only media messages carry addressable parts.
    let body: unknown;
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(init?.body as string);
      return new Response(null, { status: 204 });
    });
    const client = new RelayClient({
      token: "rly_live_test",
      fetch: fetchMock as typeof fetch,
    });
    await client.react({
      messageId: "msg_media",
      operation: "add",
      type: "emoji",
      emoji: "❤️",
      targetPartId: "prt_1",
    });
    expect(body).toMatchObject({ target_part_id: "prt_1" });
  });

  it("posts a second reply in one turn, because nothing scopes a group reply now", async () => {
    let adapter!: RelayAdapter;
    const built = harness([], async (threadId) => {
      await adapter.postMessage(threadId, "first");
      await adapter.postMessage(threadId, "second");
    });
    adapter = built.adapter;
    await adapter.handleWebhook(signedRequest(JSON.stringify(messageEvent())));
    expect(built.calls).toHaveLength(2);
    const ids = built.calls.map(
      (call) => (call.body as { message_id: string }).message_id,
    );
    // Two logical sends, two identities: neither send can replay the other.
    expect(new Set(ids).size).toBe(2);
    for (const call of built.calls) {
      expect(call.headers["idempotency-key"]).toBeUndefined();
    }
  });

  it("mints a fresh id per send, so a failed send's id is never reused", async () => {
    // The id is the retry key, and this adapter mints one per call rather than
    // holding it across a failure, so a caller that re-posts after an error is
    // posting again on purpose rather than silently replaying.
    let adapter!: RelayAdapter;
    const built = harness(
      [{ status: 500, body: { error: { code: "internal", message: "boom" } } }],
      async (threadId) => {
        await expect(adapter.postMessage(threadId, "hello")).rejects.toThrow();
        await adapter.postMessage(threadId, "hello");
      },
    );
    adapter = built.adapter;
    await adapter.handleWebhook(signedRequest(JSON.stringify(messageEvent())));
    expect(built.calls).toHaveLength(2);
    const ids = built.calls.map(
      (call) => (call.body as { message_id: string }).message_id,
    );
    expect(new Set(ids).size).toBe(2);
  });

  it("delivers a reply past the 32-part ceiling as several messages", async () => {
    // Relay caps one message at 32 parts and never splits a send itself, so
    // the follow-up messages are this adapter's own choice.
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
  it("sends an emoji character on the reactions route", async () => {
    const { adapter, calls } = harness();
    await adapter.addReaction("relay:cnv_1", "msg_1", "👍");
    const call = calls.at(-1) as RecordedCall;
    expect(call.url).toBe("https://api.relayapp.im/v1/messages/msg_1/reactions");
    expect(call.body).toEqual({ operation: "add", type: "emoji", emoji: "👍" });
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

  it("starts and stops the ephemeral typing indicator", async () => {
    const { adapter, calls } = harness([
      { status: 204, body: {} },
      { status: 204, body: {} },
    ]);
    await adapter.startTyping("relay:cnv_1", "a label Relay has nowhere to put");
    await adapter.stopTyping("relay:cnv_1");
    const [start, stop] = calls as [RecordedCall, RecordedCall];
    expect(start.url).toBe("https://api.relayapp.im/v1/conversations/cnv_1/typing");
    // Fire and forget: a bare started flag, no label, no lease, no invocation.
    expect(start.body).toEqual({ started: true });
    expect(stop.body).toEqual({ started: false });
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
              kind: "message",
              sender: { kind: "user", id: "usr_1" },
              status: "sent",
              parts: [{ part_id: "prt_b", part_index: 0, type: "text", text: "second" }],
              created_at: "2026-08-19T00:00:01.000Z",
            },
            {
              id: "msg_a",
              conversation_id: "cnv_1",
              sequence: 8,
              kind: "message",
              sender: { kind: "user", id: "usr_1" },
              status: "sent",
              parts: [{ part_id: "prt_a", part_index: 0, type: "text", text: "first" }],
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

  it("asks for at most the 100 rows the route will serve", async () => {
    // The route clamps limit to 1..100 (messages.ts:418). Asking for 200 and
    // testing the 100 rows that arrive against 200 reads as end of history.
    const { adapter, calls } = harness([{ body: { messages: [] } }]);
    const result = await adapter.fetchMessages("relay:cnv_1", { limit: 200 });
    expect((calls[0] as RecordedCall).url).toBe(
      "https://api.relayapp.im/v1/conversations/cnv_1/messages?limit=100",
    );
    expect(result.nextCursor).toBeUndefined();
  });

  it("offers another page when the clamped limit came back full", async () => {
    const messages = Array.from({ length: 100 }, (_, index) => ({
      id: `msg_${index}`,
      conversation_id: "cnv_1",
      sequence: 100 + index,
      kind: "message",
      sender: { kind: "user", id: "usr_1" },
      status: "sent",
      parts: [{ part_id: `prt_${index}`, part_index: 0, type: "text", text: `line ${index}` }],
      created_at: "2026-08-19T00:00:00.000Z",
    }));
    const { adapter } = harness([{ body: { messages } }]);
    const result = await adapter.fetchMessages("relay:cnv_1", { limit: 200 });
    expect(result.messages).toHaveLength(100);
    expect(result.nextCursor).toBe("100");
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
