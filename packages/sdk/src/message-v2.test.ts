import { describe, expect, it } from "vitest";
import type { RelayClient } from "./client.js";
import {
  buildEditRequest,
  classifyCursorGap,
  createRelayClient,
  MAX_OPERATIONS_PER_EDIT,
} from "./client.js";
import { RelayApiError } from "./errors.js";
import { MemoryDedupe } from "./memory-dedupe.js";
import { runPollLoop } from "./poll-loop.js";
import { isKnownPartKind, isVisibleMessage } from "./types.js";
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
    expect(isRelayId(id, "mut")).toBe(false);
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

describe("send response parsing", () => {
  const committed: RelayMessage[] = [
    {
      id: "msg_01k1m9x2ph4vb7k0d3wzr8ftqe",
      conversation_id: "cnv_01k1m4q9vn2r7t9b4c6qdh8xwy",
      sequence: 8,
      sender: { kind: "agent", id: "agt_01k1m7v9wr4t2b8n5c3qjd6hzx" },
      is_from_me: true,
      parts: [],
      reply_to: null,
      fallback_text: "first",
      status: "sent",
      version: 1,
      created_at: "2026-08-24T20:00:00.000Z",
    },
    {
      id: "msg_01k1m9x2pjd7r3v8b2ncq5hwtf",
      conversation_id: "cnv_01k1m4q9vn2r7t9b4c6qdh8xwy",
      sequence: 9,
      sender: { kind: "agent", id: "agt_01k1m7v9wr4t2b8n5c3qjd6hzx" },
      is_from_me: true,
      parts: [],
      reply_to: null,
      fallback_text: "second",
      status: "sent",
      version: 1,
      created_at: "2026-08-24T20:00:01.000Z",
    },
  ];

  function clientAnswering(body: unknown, status = 201): {
    client: RelayClient;
    requests: Array<{ url: string; init: RequestInit | undefined }>;
  } {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const client = createRelayClient({
      token: "relay_test_token",
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

  it("reads the messages array the server actually returns", async () => {
    // The server answers `{ message_id, messages }`. Reading `body.message`
    // resolved every send with `message: undefined`.
    const { client } = clientAnswering({ message_id: committed[0]!.id, messages: committed });
    const result = await client.sendMessage({
      conversationId: "cnv_01k1m4q9vn2r7t9b4c6qdh8xwy",
      parts: [{ type: "text", text: "first" }],
      idempotencyKey: "reply-evt_1",
    });
    expect(result.messages).toHaveLength(2);
    expect(result.message).toBeDefined();
    expect(result.message.id).toBe(committed[0]!.id);
    expect(result.messageId).toBe(committed[0]!.id);
  });

  it("falls back to the first message's id when message_id is absent", async () => {
    const { client } = clientAnswering({ messages: committed });
    const result = await client.sendMessage({
      conversationId: "cnv_01k1m4q9vn2r7t9b4c6qdh8xwy",
      parts: [{ type: "text", text: "first" }],
      idempotencyKey: "reply-evt_1",
    });
    expect(result.messageId).toBe(committed[0]!.id);
  });

  it("raises rather than resolving with an undefined message", async () => {
    const { client } = clientAnswering({ message_id: committed[0]!.id });
    await expect(client.sendMessage({
      conversationId: "cnv_01k1m4q9vn2r7t9b4c6qdh8xwy",
      parts: [{ type: "text", text: "first" }],
      idempotencyKey: "reply-evt_1",
    })).rejects.toBeInstanceOf(RelayApiError);
  });

  it("mints a msg_ id for a v2 send and sends it as the body's message_id", async () => {
    const { client, requests } = clientAnswering({ message: committed[0] });
    const result = await client.sendMessageV2({
      conversationId: "cnv_01k1m4q9vn2r7t9b4c6qdh8xwy",
      parts: [{ type: "text", text: "one message" }],
    });
    expect(result.messageId).toMatch(/^msg_[0-9a-hjkmnp-tv-z]{26}$/);
    const sent = JSON.parse(String(requests[0]!.init?.body)) as { message_id: string };
    expect(sent.message_id).toBe(result.messageId);
    expect(requests[0]!.url).toContain("/v2/conversations/");
    expect(requests[0]!.init?.headers).not.toHaveProperty("idempotency-key");
  });

  it("uses a caller's message id verbatim, so a retry resolves to one message", async () => {
    const { client, requests } = clientAnswering({ message: committed[0] });
    const messageId = "msg_01k1m9x2ph4vb7k0d3wzr8ftqe";
    await client.sendMessageV2({
      conversationId: "cnv_01k1m4q9vn2r7t9b4c6qdh8xwy",
      messageId,
      parts: [{ type: "text", text: "one message" }],
    });
    await client.sendMessageV2({
      conversationId: "cnv_01k1m4q9vn2r7t9b4c6qdh8xwy",
      messageId,
      parts: [{ type: "text", text: "one message" }],
    });
    const ids = requests.map((entry) => (JSON.parse(String(entry.init?.body)) as { message_id: string }).message_id);
    expect(ids).toEqual([messageId, messageId]);
  });
});

describe("buildEditRequest", () => {
  const partId = "prt_01k1ma0m5r9xd4t7c2vqj6nzbh";

  it("mints an operation id and carries the operations through", () => {
    const request = buildEditRequest({
      expectedVersion: 2,
      operations: [{ action: "remove", part_id: partId }],
    });
    expect(request.operation_id).toMatch(/^mut_[0-9a-hjkmnp-tv-z]{26}$/);
    expect(request.expected_version).toBe(2);
    expect(request.operations).toEqual([{ action: "remove", part_id: partId }]);
  });

  it("keeps a caller's operation id, which is what makes a retry a replay", () => {
    const operationId = "mut_01k1mb4h8w6nq2t5v9c3jr7dzf";
    const first = buildEditRequest({ operationId, expectedVersion: 1, operations: [{ action: "remove", part_id: partId }] });
    const retry = buildEditRequest({ operationId, expectedVersion: 1, operations: [{ action: "remove", part_id: partId }] });
    expect(retry).toEqual(first);
  });

  it("mints a different id each time when the caller supplies none", () => {
    const operations = [{ action: "remove" as const, part_id: partId }];
    const first = buildEditRequest({ expectedVersion: 1, operations });
    const second = buildEditRequest({ expectedVersion: 1, operations });
    expect(second.operation_id).not.toBe(first.operation_id);
  });

  it("refuses an edit that cannot succeed", () => {
    expect(() => buildEditRequest({ expectedVersion: 1, operations: [] }))
      .toThrow(/at least one operation/);
    expect(() => buildEditRequest({ expectedVersion: 0, operations: [{ action: "remove", part_id: partId }] }))
      .toThrow(/expectedVersion/);
    expect(() => buildEditRequest({
      expectedVersion: 1,
      operations: Array.from({ length: MAX_OPERATIONS_PER_EDIT + 1 }, () => ({ action: "remove" as const, part_id: partId })),
    })).toThrow(/at most 64/);
  });
});

describe("classifyCursorGap", () => {
  it("names an expired cursor so the caller reconciles instead of retrying", () => {
    const error = new RelayApiError("cursor expired", {
      status: 410,
      kind: "rejected",
      code: "cursor_expired",
    });
    expect(classifyCursorGap({ cursor: 41, error })).toEqual({ kind: "expired", resumeFrom: 41 });
  });

  it("names a cursor ahead of what Relay delivered", () => {
    const error = new RelayApiError("cursor ahead", {
      status: 422,
      kind: "rejected",
      code: "invalid_request",
      details: { highest_delivered_cursor: 41 },
    });
    expect(classifyCursorGap({ cursor: 99, error }))
      .toEqual({ kind: "ahead", highestDeliveredCursor: 41 });
  });

  it("advances on a clean page", () => {
    expect(classifyCursorGap({ cursor: 41, page: { events: [], nextCursor: 44 } }))
      .toEqual({ kind: "none", resumeCursor: 44 });
  });
});

describe("quoting replies", () => {
  const base = {
    id: "msg_01k1m9x2ph4vb7k0d3wzr8ftqe",
    conversation_id: "cnv_01k1m4q9vn2r7t9b4c6qdh8xwy",
    sequence: 1,
    sender: { kind: "user" as const, id: "usr_01k1m8t3zq7v2r9c4b6ndh5xwj" },
    is_from_me: false,
    reply_to: null,
    fallback_text: "hi",
    status: "sent" as const,
    version: 1,
    created_at: "2026-08-24T20:00:00.000Z",
  };

  async function quotedReplyTarget(parts: RelayPart[]): Promise<Record<string, unknown>> {
    const sends: Array<Record<string, unknown>> = [];
    const abort = new AbortController();
    const event = {
      event_id: "evt_1",
      event_type: "message.received",
      agent_id: "agt_01k1m7v9wr4t2b8n5c3qjd6hzx",
      created_at: base.created_at,
      data: { message: { ...base, parts } },
    } as MessageReceivedEvent;
    const client = {
      pollEvents: async () => ({ events: [event], nextCursor: 1 }),
      sendText: async (params: Record<string, unknown>) => {
        sends.push(params);
        return { messageId: "msg_reply", message: event.data.message, messages: [event.data.message] };
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

  it("quotes the target's first part by its stable id", async () => {
    const replyTo = await quotedReplyTarget([
      { part_id: "prt_01k1ma0m5r9xd4t7c2vqj6nzbh", part_index: 0, position: 0, type: "text", text: "hi" },
    ]);
    expect(replyTo).toEqual({
      message_id: base.id,
      part_id: "prt_01k1ma0m5r9xd4t7c2vqj6nzbh",
    });
  });

  it("falls back to the legacy index for a payload stored before part ids", async () => {
    const legacy = [{ part_index: 0, type: "text", text: "hi" }] as unknown as RelayPart[];
    const replyTo = await quotedReplyTarget(legacy);
    expect(replyTo).toEqual({ message_id: base.id, part_index: 0 });
  });
});

describe("tolerating what this version does not know", () => {
  it("keeps an unknown part type instead of dropping it", () => {
    const part = {
      part_id: "prt_01k1ma0m5r9xd4t7c2vqj6nzbh",
      part_index: 0,
      position: 0,
      type: "poll",
      poll_id: "pol_01k1mc7d2x5rn8v3b6qwjt4hzf",
    } satisfies RelayPart;
    expect(isKnownPartKind(part)).toBe(false);
    expect(part.part_id).toBeDefined();
    const text = { part_id: part.part_id, part_index: 1, position: 1, type: "text", text: "hi" } satisfies RelayPart;
    expect(isKnownPartKind(text)).toBe(true);
  });

  it("narrows a tombstone away from a visible message", () => {
    const tombstone: RelayMessage = {
      id: "msg_01k1m9x2ph4vb7k0d3wzr8ftqe",
      conversation_id: "cnv_01k1m4q9vn2r7t9b4c6qdh8xwy",
      sequence: 8,
      sender: { kind: "user", id: "usr_01k1m8t3zq7v2r9c4b6ndh5xwj" },
      status: "deleted",
      unsent_at: "2026-08-24T20:04:00.000Z",
      created_at: "2026-08-24T20:00:00.000Z",
    };
    expect(isVisibleMessage(tombstone)).toBe(false);
  });
});
