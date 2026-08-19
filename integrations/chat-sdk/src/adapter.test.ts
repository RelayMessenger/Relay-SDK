import { createHmac } from "node:crypto";
import type { ChatInstance, Message } from "chat";
import { describe, expect, it, vi } from "vitest";
import {
  RelayAdapter,
  RelayInvocationSpentError,
  createRelayAdapter,
} from "./adapter.js";
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
 * The turn an inbound event opens lives on the async context of its dispatch,
 * so a test that needs one has to reply from inside `processMessage` the way a
 * real handler does. `onMessage` is that handler.
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
        messages: [{ id: "msg_out", conversation_id: "cnv_1" }],
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
      threadId: string,
      message: Message<RelayRawMessage> | (() => Promise<Message<RelayRawMessage>>),
    ) {
      const resolved = typeof message === "function" ? await message() : message;
      seen.messages.push(resolved);
      if (onMessage) await onMessage(threadId, resolved);
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

  it("claims the event id before dispatching, so two concurrent redeliveries cannot both run", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { adapter, chat } = harness([], async () => {
      await gate;
    });
    const body = JSON.stringify(messageEvent());
    // Both are in flight before either can finish: the first dispatch is held
    // open until the timer fires, which is what a redelivery racing its
    // original looks like. A check that only records on the way out lets the
    // second one past.
    const first = adapter.handleWebhook(signedRequest(body, "whmsg_1"));
    const second = adapter.handleWebhook(signedRequest(body, "whmsg_2"));
    setTimeout(() => release?.(), 20);
    const [, secondResponse] = await Promise.all([first, second]);
    expect(await secondResponse.json()).toEqual({ deduplicated: true });
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
          part_index: 0,
          type: "text",
          text: "alpha bravo",
          styles: [{ start: 6, length: 5, styles: ["bold"] }],
        },
        {
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
        { part_index: 0, type: "text", text: "" },
        {
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
  it("posts the OpenAPI payload shape with a keyed idempotent send", async () => {
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
    // The key names the event and the position, and nothing else: that is what
    // lets Relay replay a redelivery and refuse a diverging one.
    expect(post.headers["idempotency-key"]).toBe("relay:evt_01TEST:0");
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

  it("threads a group invocation into the first reply and refuses a second", async () => {
    let adapter!: RelayAdapter;
    let second: unknown;
    const built = harness([], async (threadId) => {
      await adapter.postMessage(threadId, "first");
      second = await adapter
        .postMessage(threadId, "second")
        .then(() => undefined)
        .catch((error: unknown) => error);
    });
    adapter = built.adapter;
    await adapter.handleWebhook(
      signedRequest(JSON.stringify(messageEvent({}, "ivk_01k1m4q9vn2r7t9b4c6qdh8xwy"))),
    );
    expect((built.calls[0] as RecordedCall).body).toMatchObject({
      invocation_id: "ivk_01k1m4q9vn2r7t9b4c6qdh8xwy",
    });
    // A bare second send is a 403 from Relay: group agent replies require an
    // invocation and this turn spent its only one.
    expect(second).toBeInstanceOf(RelayInvocationSpentError);
    expect(built.calls).toHaveLength(1);
  });

  it("allows a second reply in a direct conversation, where no invocation is in play", async () => {
    let adapter!: RelayAdapter;
    const built = harness([], async (threadId) => {
      await adapter.postMessage(threadId, "first");
      await adapter.postMessage(threadId, "second");
    });
    adapter = built.adapter;
    await adapter.handleWebhook(signedRequest(JSON.stringify(messageEvent())));
    expect(built.calls).toHaveLength(2);
    for (const call of built.calls) {
      expect(call.body).not.toHaveProperty("invocation_id");
    }
    // Two logical sends in one turn, so two positions.
    expect(built.calls.map((call) => call.headers["idempotency-key"])).toEqual([
      "relay:evt_01TEST:0",
      "relay:evt_01TEST:1",
    ]);
  });

  it("keeps the ordinal where it was when a send failed, so the retry reuses the key", async () => {
    let adapter!: RelayAdapter;
    let retried: string | undefined;
    const built = harness(
      [{ status: 500, body: { error: { code: "internal", message: "boom" } } }],
      async (threadId) => {
        await expect(adapter.postMessage(threadId, "hello")).rejects.toThrow();
        await adapter.postMessage(threadId, "hello");
        retried = (built.calls.at(-1) as RecordedCall).headers["idempotency-key"];
      },
    );
    adapter = built.adapter;
    await adapter.handleWebhook(signedRequest(JSON.stringify(messageEvent())));
    expect(built.calls).toHaveLength(2);
    expect(built.calls[0]?.headers["idempotency-key"]).toBe("relay:evt_01TEST:0");
    expect(retried).toBe("relay:evt_01TEST:0");
  });

  it("gives each concurrent turn on one conversation its own event and invocation", async () => {
    let adapter!: RelayAdapter;
    let releaseFirst: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const built = harness([], async (threadId, message) => {
      if (message.raw.event_id === "evt_A") await gate;
      await adapter.postMessage(threadId, message.raw.event_id ?? "");
    });
    adapter = built.adapter;

    const first = adapter.handleWebhook(
      signedRequest(JSON.stringify(messageEvent({ event_id: "evt_A" })), "whmsg_a"),
    );
    // The Chat SDK takes its per-thread lock inside processMessage, so a second
    // event lands here while the first is still waiting. Turn state kept in a
    // map keyed by conversation would be overwritten at this point.
    await adapter.handleWebhook(
      signedRequest(JSON.stringify(messageEvent({ event_id: "evt_B" })), "whmsg_b"),
    );
    releaseFirst?.();
    await first;

    const keyed = new Map(
      built.calls.map((call) => [
        (call.body as { parts: Array<{ text: string }> }).parts[0]?.text,
        call.headers["idempotency-key"],
      ]),
    );
    expect(keyed.get("evt_A")).toBe("relay:evt_A:0");
    expect(keyed.get("evt_B")).toBe("relay:evt_B:0");
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

  it("posts an ephemeral typing label bounded to 80 characters", async () => {
    const { adapter, calls } = harness([{ status: 204, body: {} }]);
    await adapter.startTyping("relay:cnv_1", "x".repeat(120));
    const call = calls.at(-1) as RecordedCall;
    expect(call.url).toBe("https://api.relayapp.im/v1/conversations/cnv_1/typing");
    expect((call.body as { label: string }).label).toHaveLength(80);
  });

  it("swallows a typing failure rather than taking the reply down with it", async () => {
    // Group typing with no live pending invocation is a 403, which is exactly
    // what typing after the first send of a group turn looks like.
    const { adapter } = harness([
      { status: 403, body: { error: { code: "forbidden", message: "invocation is not pending" } } },
    ]);
    await expect(adapter.startTyping("relay:cnv_1", "thinking")).resolves.toBeUndefined();
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
      sender: { kind: "user", id: "usr_1" },
      status: "sent",
      parts: [{ part_index: 0, type: "text", text: `line ${index}` }],
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
