import { describe, expect, it } from "vitest";
import type { RelayClient } from "./client.js";
import { createRelayClient } from "./client.js";
import { RelayApiError } from "./errors.js";
import { MemoryDedupe } from "./memory-dedupe.js";
import { runPollLoop } from "./poll-loop.js";
import { isKnownPartKind } from "./types.js";
import type { MessageReceivedEvent, RelayMessage, RelayPart } from "./types.js";
import { createUlidFactory, isRelayId, RELAY_ID_PATTERN, relayId, ulid } from "./ulid.js";

const CROCKFORD = /^[0-9a-hjkmnp-tv-z]{26}$/;

describe("ulid", () => {
  it("emits 26 lowercase Crockford characters", () => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      expect(ulid()).toMatch(CROCKFORD);
    }
  });

  it("never emits the characters Crockford excludes", () => {
    // i, l, o and u are excluded so a handwritten id cannot be misread. An
    // implementation that lowercased a canonical uppercase ULID would emit
    // them, so this is the assertion that catches that shortcut.
    let sample = "";
    for (let attempt = 0; attempt < 500; attempt += 1) sample += ulid();
    expect(sample).not.toMatch(/[ilou]/);
  });

  it("prefixes a Relay id and validates it", () => {
    const id = relayId("msg");
    expect(id).toMatch(/^msg_[0-9a-hjkmnp-tv-z]{26}$/);
    expect(RELAY_ID_PATTERN.test(id)).toBe(true);
    expect(isRelayId(id, "msg")).toBe(true);
    expect(isRelayId(id, "prt")).toBe(false);
    expect(isRelayId(id.toUpperCase(), "msg")).toBe(false);
    expect(isRelayId("msg_short", "msg")).toBe(false);
  });

  it("rejects a prefix that is not a Relay prefix", () => {
    expect(() => relayId("MSG")).toThrow(/prefix/);
    expect(() => relayId("toolong")).toThrow(/prefix/);
  });

  it("is monotonic inside one millisecond", () => {
    // A frozen clock forces every id into the same timestamp, so the ordering
    // can only come from the random component being incremented.
    const mint = createUlidFactory(() => 1_800_000_000_000);
    const ids = Array.from({ length: 1_000 }, () => mint());
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
    expect(ids.every((id) => CROCKFORD.test(id))).toBe(true);
  });

  it("stays monotonic when the clock goes backwards", () => {
    let now = 1_800_000_000_000;
    const mint = createUlidFactory(() => now);
    const first = mint();
    now -= 5_000;
    const second = mint();
    expect(second > first).toBe(true);
  });

  it("is monotonic across a real clock", () => {
    const ids = Array.from({ length: 500 }, () => ulid());
    expect([...ids].sort()).toEqual(ids);
  });
});

const committed: RelayMessage = {
  id: "msg_01k1m9x2ph4vb7k0d3wzr8ftqe",
  chat_id: "cnv_01k1m4q9vn2r7t9b4c6qdh8xwy",
  sequence: 8,
  item_type: 0,
  sender_handle: { kind: "agent", id: "agt_01k1m7v9wr4t2b8n5c3qjd6hzx" },
  is_from_me: true,
  parts: [{ part_id: "prt_01k1ma0m5r9xd4t7c2vqj6nzbh", part_index: 0, type: "text", text: "first" }],
  reply_to: null,
  text: "first",
  status: "sent",
  created_at: "2026-08-24T20:00:00.000Z",
};

function clientAnswering(body: unknown, status = 201): {
  client: RelayClient;
  requests: Array<{ url: string; init: RequestInit | undefined }>;
} {
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  const client = createRelayClient({
    token: "rly_live_test",
    baseUrl: "http://127.0.0.1:8788",
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    },
  });
  return { client, requests };
}

describe("send response parsing", () => {
  it("mints a msg_ id and sends it as the body's message_id", async () => {
    const { client, requests } = clientAnswering({ message: committed });
    const result = await client.sendMessage({
      chatId: committed.chat_id,
      parts: [{ type: "text", text: "one message" }],
    });
    expect(result.messageId).toMatch(/^msg_[0-9a-hjkmnp-tv-z]{26}$/);
    expect(result.message.id).toBe(committed.id);
    const sent = JSON.parse(String(requests[0]!.init?.body)) as { message_id: string };
    expect(sent.message_id).toBe(result.messageId);
    expect(requests[0]!.url).toContain("/v2/conversations/");
  });

  it("carries no Idempotency-Key: the message id is the whole retry story", async () => {
    const { client, requests } = clientAnswering({ message: committed });
    await client.sendMessage({
      chatId: committed.chat_id,
      parts: [{ type: "text", text: "one message" }],
    });
    const headers = requests[0]!.init?.headers as Record<string, string>;
    expect(Object.keys(headers).map((key) => key.toLowerCase()))
      .not.toContain("idempotency-key");
  });

  it("uses a caller's message id verbatim, so a retry is the same send", async () => {
    const { client, requests } = clientAnswering({ message: committed });
    const messageId = committed.id;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await client.sendMessage({
        chatId: committed.chat_id,
        messageId,
        parts: [{ type: "text", text: "one message" }],
      });
    }
    const ids = requests.map((entry) =>
      (JSON.parse(String(entry.init?.body)) as { message_id: string }).message_id);
    expect(ids).toEqual([messageId, messageId]);
  });

  it("raises rather than resolving with an undefined message", async () => {
    const { client } = clientAnswering({});
    await expect(client.sendMessage({
      chatId: committed.chat_id,
      parts: [{ type: "text", text: "first" }],
    })).rejects.toBeInstanceOf(RelayApiError);
  });

  it("reads the single-element array /v1 still answers with", async () => {
    // One send is one message. `/v1` keeps the array because shipped clients
    // read one, not because anything is ever split into several.
    const { client, requests } = clientAnswering({ messages: [committed] });
    const result = await client.sendMessageV1({
      chatId: committed.chat_id,
      messageId: committed.id,
      parts: [{ type: "text", text: "first" }],
    });
    expect(result.message.id).toBe(committed.id);
    expect(result.messageId).toBe(committed.id);
    expect(requests[0]!.url).toContain("/v1/conversations/");
  });

  it("raises when /v1 answers with an empty array", async () => {
    const { client } = clientAnswering({ messages: [] });
    await expect(client.sendMessageV1({
      chatId: committed.chat_id,
      parts: [{ type: "text", text: "first" }],
    })).rejects.toBeInstanceOf(RelayApiError);
  });
});

describe("pollEvents", () => {
  it("sends `after` and reads the page's cursor, ceiling and backlog flag", async () => {
    const { client, requests } = clientAnswering(
      { events: [], next_cursor: 44, latest: 51, has_more: true },
      200,
    );
    const page = await client.pollEvents({ after: 41, timeoutSeconds: 5 });
    expect(requests[0]!.url).toContain("after=41");
    expect(requests[0]!.url).toContain("timeout=5");
    expect(requests[0]!.url).not.toContain("cursor=");
    expect(page).toEqual({ events: [], nextCursor: 44, latest: 51, hasMore: true });
  });

  it("holds the cursor where it was when the page is empty", async () => {
    const { client } = clientAnswering({ events: [] }, 200);
    const page = await client.pollEvents({ after: 41 });
    expect(page.nextCursor).toBe(41);
    expect(page.latest).toBe(41);
    expect(page.hasMore).toBe(false);
  });
});

describe("reactions", () => {
  const reaction = {
    message_id: committed.id,
    target_part_id: null,
    type: "custom" as const,
    custom_customEmoji: "🔥",
    actor: { kind: "agent" as const, id: "agt_01k1m7v9wr4t2b8n5c3qjd6hzx" },
    operation: "add" as const,
    changed: true,
  };

  it("targets the whole message when no part is named", async () => {
    const { client, requests } = clientAnswering({ reaction }, 200);
    const result = await client.react({
      messageId: committed.id,
      operation: "add",
      customEmoji: "🔥",
    });
    expect(result.target_part_id).toBeNull();
    const body = JSON.parse(String(requests[0]!.init?.body)) as Record<string, unknown>;
    expect(body).toEqual({ operation: "add", type: "custom", emoji: "🔥" });
  });

  it("names one exact part by its permanent id, never by a slot index", async () => {
    const partId = "prt_01k1ma0m5r9xd4t7c2vqj6nzbh";
    const { client, requests } = clientAnswering(
      { reaction: { ...reaction, target_part_id: partId } },
      200,
    );
    await client.react({
      messageId: committed.id,
      operation: "add",
      customEmoji: "🔥",
      targetPartId: partId,
    });
    const body = JSON.parse(String(requests[0]!.init?.body)) as Record<string, unknown>;
    expect(body["target_part_id"]).toBe(partId);
    expect(body).not.toHaveProperty("target_scope");
    expect(body).not.toHaveProperty("part_index");
    expect(body).not.toHaveProperty("operation_id");
  });
});

describe("typing", () => {
  it("is one fire-and-forget flag: no label, no lease, no invocation", async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const client = createRelayClient({
      token: "rly_live_test",
      baseUrl: "http://127.0.0.1:8788",
      fetchImpl: async (url, init) => {
        requests.push({ url, init });
        return new Response(null, { status: 204 });
      },
    });
    await client.setTyping({ chatId: "cnv/a", started: true });
    expect(requests[0]!.url).toBe("http://127.0.0.1:8788/v1/conversations/cnv%2Fa/typing");
    expect(JSON.parse(String(requests[0]!.init?.body))).toEqual({ started: true });
  });
});

describe("quoting replies", () => {
  async function quotedReplyTarget(parts: RelayPart[]): Promise<Record<string, unknown>> {
    const sends: Array<Record<string, unknown>> = [];
    const abort = new AbortController();
    const event = {
      event_id: "evt_01k1mc7d2x5rn8v3b6qwjt4hzf",
      sequence: 1,
      event_type: "message.received",
      agent_id: "agt_01k1m7v9wr4t2b8n5c3qjd6hzx",
      chat_id: committed.chat_id,
      created_at: committed.created_at,
      data: { message: { ...committed, is_from_me: false, sender_handle: { kind: "user", id: "usr_01k1m8t3zq7v2r9c4b6ndh5xwj" }, parts } },
    } as MessageReceivedEvent;
    const client = {
      pollEvents: async () => ({ events: [event], nextCursor: 1, latest: 1, hasMore: false }),
      sendText: async (params: Record<string, unknown>) => {
        sends.push(params);
        return { messageId: "msg_01k1m9x2pjd7r3v8b2ncq5hwtf", message: event.data.message };
      },
    } as unknown as RelayClient;
    await runPollLoop({
      client,
      getCursor: () => 0,
      setCursor: () => {},
      dedupe: new MemoryDedupe(),
      abortSignal: abort.signal,
      onMessage: async (ctx) => {
        await ctx.reply.text("quoted", { quote: true });
        abort.abort();
      },
    });
    return sends[0]?.["replyTo"] as Record<string, unknown>;
  }

  it("points at the target's first part by its permanent id", async () => {
    // A reply is a pointer, not a copied quote: the renderer resolves it
    // against the target message it already holds.
    const replyTo = await quotedReplyTarget([
      { part_id: "prt_01k1ma0m5r9xd4t7c2vqj6nzbh", part_index: 0, type: "text", text: "hi" },
    ]);
    expect(replyTo).toEqual({
      message_id: committed.id,
      part_id: "prt_01k1ma0m5r9xd4t7c2vqj6nzbh",
    });
  });

  it("points at the message alone when the payload carries no part id", async () => {
    const legacy = [{ part_index: 0, type: "text", text: "hi" }] as unknown as RelayPart[];
    expect(await quotedReplyTarget(legacy)).toEqual({ message_id: committed.id });
  });
});

describe("tolerating what this version does not know", () => {
  it("keeps an unknown part type instead of dropping it", () => {
    const part = {
      part_id: "prt_01k1ma0m5r9xd4t7c2vqj6nzbh",
      part_index: 0,
      type: "sticker",
      sticker_id: "stk_01k1mc7d2x5rn8v3b6qwjt4hzf",
    } satisfies RelayPart;
    expect(isKnownPartKind(part)).toBe(false);
    expect(part.part_id).toBeDefined();
  });

  it("knows the part kinds it publishes a shape for, polls included", () => {
    for (const type of ["text", "media", "link", "data"]) {
      const part = { part_id: "prt_01k1ma0m5r9xd4t7c2vqj6nzbh", part_index: 0, type } satisfies RelayPart;
      expect(isKnownPartKind(part)).toBe(true);
    }
  });
});
