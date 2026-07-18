import { describe, expect, it } from "vitest";
import { createRelayClient, isRelayWebhookConflict, RelayApiError } from "./client.js";
import {
  deriveRelayIdempotencyKey,
  reconcileRelayUnknownSend,
  RELAY_TEXT_CHUNK_LIMIT,
  sendRelayText,
} from "./outbound.js";
import type { RelayMessage } from "./types.js";

type RecordedRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
};

function fakeFetch(
  responder: (request: RecordedRequest) => { status: number; body?: unknown },
) {
  const requests: RecordedRequest[] = [];
  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const request: RecordedRequest = {
      url: input,
      method: init?.method ?? "GET",
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
          k.toLowerCase(),
          v,
        ]),
      ),
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    };
    requests.push(request);
    const { status, body } = responder(request);
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetchImpl, requests };
}

function sentMessage(id = "msg_out"): { message_id: string; message: RelayMessage } {
  return {
    message_id: id,
    message: {
      id,
      conversation_id: "cnv_1",
      sequence: 8,
      sender: { kind: "agent", id: "agt_self" },
      parts: [{ part_index: 0, type: "text", text: "hi" }],
      reply_to: null,
      fallback_text: "hi",
      status: "sent",
      created_at: "2026-07-17T00:00:02.000Z",
    },
  };
}

describe("deriveRelayIdempotencyKey", () => {
  it("is a stable function of (queueId, partIndex)", () => {
    const a = deriveRelayIdempotencyKey({ deliveryQueueId: "q1", deliveryPartIndex: 2 });
    const b = deriveRelayIdempotencyKey({ deliveryQueueId: "q1", deliveryPartIndex: 2 });
    expect(a).toBe(b);
    expect(a).toBe("relay-send:q1:2");
  });

  it("distinguishes parts of the same logical send", () => {
    expect(deriveRelayIdempotencyKey({ deliveryQueueId: "q1", deliveryPartIndex: 0 })).not.toBe(
      deriveRelayIdempotencyKey({ deliveryQueueId: "q1", deliveryPartIndex: 1 }),
    );
  });

  it("defaults the part index to 0 so reconciliation can rebuild the key", () => {
    expect(deriveRelayIdempotencyKey({ deliveryQueueId: "q1" })).toBe(
      deriveRelayIdempotencyKey({ deliveryQueueId: "q1", deliveryPartIndex: 0 }),
    );
  });

  it("mints unique keys without a queue id", () => {
    const a = deriveRelayIdempotencyKey({});
    const b = deriveRelayIdempotencyKey({});
    expect(a).not.toBe(b);
  });

  it("stays inside the server's 8-255 char window", () => {
    const short = deriveRelayIdempotencyKey({ deliveryQueueId: "q" });
    expect(short.length).toBeGreaterThanOrEqual(8);
    const long = deriveRelayIdempotencyKey({ deliveryQueueId: "x".repeat(400) });
    expect(long.length).toBeLessThanOrEqual(255);
  });
});

describe("logical-send idempotency", () => {
  it("preserves two intentional identical sends when no queue id exists", () => {
    const values = ["uuid-a", "uuid-b"];
    const random = () => values.shift()!;
    const a = deriveRelayIdempotencyKey({ random });
    const b = deriveRelayIdempotencyKey({ random });
    expect(a).toBe("relay-send:uuid-a");
    expect(b).toBe("relay-send:uuid-b");
  });

  it("hashes an oversized logical id without collapsing distinct chunks", () => {
    const queueId = "q".repeat(400);
    const a = deriveRelayIdempotencyKey({ deliveryQueueId: queueId, deliveryPartIndex: 0 });
    const b = deriveRelayIdempotencyKey({ deliveryQueueId: queueId, deliveryPartIndex: 1 });
    expect(a).toMatch(/^relay-send:h:[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });
});

describe("409 discrimination", () => {
  it("carries the server error code and flags the webhook XOR conflict", async () => {
    const { fetchImpl } = fakeFetch(() => ({
      status: 409,
      body: { error: { code: "conflict", message: "webhook endpoint enabled" } },
    }));
    const client = createRelayClient({ baseUrl: "https://api.test", token: "tok", fetchImpl });
    const error = await client
      .pollEvents({ cursor: 0 })
      .then(() => null)
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(RelayApiError);
    expect((error as RelayApiError).code).toBe("conflict");
    expect(isRelayWebhookConflict(error)).toBe(true);
  });

  it("does not flag terminated_by_other_consumer as a webhook conflict", async () => {
    const { fetchImpl } = fakeFetch(() => ({
      status: 409,
      body: { error: { code: "terminated_by_other_consumer", message: "lost the slot" } },
    }));
    const client = createRelayClient({ baseUrl: "https://api.test", token: "tok", fetchImpl });
    const error = await client
      .pollEvents({ cursor: 0 })
      .then(() => null)
      .catch((err: unknown) => err);
    expect((error as RelayApiError).code).toBe("terminated_by_other_consumer");
    expect(isRelayWebhookConflict(error)).toBe(false);
  });
});

describe("sendRelayText", () => {
  it("POSTs one text part with the idempotency key and reply target", async () => {
    const { fetchImpl, requests } = fakeFetch(() => ({ status: 202, body: sentMessage() }));
    const client = createRelayClient({ baseUrl: "https://api.test", token: "tok", fetchImpl });

    const result = await sendRelayText({
      client,
      conversationId: "cnv_1",
      text: "hi",
      replyToId: "msg_prev",
      idempotencyKey: "relay-send:q1:0",
    });

    expect(result.messageId).toBe("msg_out");
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.url).toBe("https://api.test/v1/messages");
    expect(request.method).toBe("POST");
    expect(request.headers["idempotency-key"]).toBe("relay-send:q1:0");
    expect(request.headers.authorization).toBe("Bearer tok");
    expect(request.body).toEqual({
      conversation_id: "cnv_1",
      parts: [{ type: "text", text: "hi" }],
      reply_to: { message_id: "msg_prev" },
    });
  });

  it("reuses the same key on caller retry so the server dedupes the send", async () => {
    const { fetchImpl, requests } = fakeFetch(() => ({ status: 202, body: sentMessage() }));
    const client = createRelayClient({ baseUrl: "https://api.test", token: "tok", fetchImpl });
    const key = deriveRelayIdempotencyKey({ deliveryQueueId: "q9" });

    await sendRelayText({ client, conversationId: "cnv_1", text: "hi", idempotencyKey: key });
    await sendRelayText({ client, conversationId: "cnv_1", text: "hi", idempotencyKey: key });

    expect(requests.map((request) => request.headers["idempotency-key"])).toEqual([key, key]);
  });

  it("reuses one logical-send key for bounded unknown-outcome retries", async () => {
    const keys: string[] = [];
    let attempts = 0;
    const client = {
      getMe: async () => {
        throw new Error("not used");
      },
      pollEvents: async () => {
        throw new Error("not used");
      },
      sendMessage: async (params: { idempotencyKey: string }) => {
        keys.push(params.idempotencyKey);
        attempts += 1;
        if (attempts === 1) {
          throw new RelayApiError("connection reset", { kind: "retryable" });
        }
        const sent = sentMessage("msg_after_retry");
        return { messageId: sent.message_id, message: sent.message };
      },
      setTyping: async () => {},
      markRead: async () => {},
    } as unknown as Parameters<typeof sendRelayText>[0]["client"];

    const result = await sendRelayText({
      client,
      conversationId: "cnv_1",
      text: "same logical send",
      idempotencyKey: "relay-send:logical-1:0",
    });

    expect(result.messageId).toBe("msg_after_retry");
    expect(keys).toEqual(["relay-send:logical-1:0", "relay-send:logical-1:0"]);
  });
});

describe("reconcileRelayUnknownSend", () => {
  const base = { conversationId: "cnv_1", text: "hi", idempotencyKey: "relay-send:q1:0" };

  it("returns sent when the idempotent replay commits or returns the original", async () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 202, body: sentMessage("msg_orig") }));
    const client = createRelayClient({ baseUrl: "https://api.test", token: "tok", fetchImpl });
    const verdict = await reconcileRelayUnknownSend({ client, ...base });
    expect(verdict).toMatchObject({ status: "sent", messageId: "msg_orig" });
  });

  it("returns non-retryable unresolved on idempotency conflict", async () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 409, body: { error: { message: "used" } } }));
    const client = createRelayClient({ baseUrl: "https://api.test", token: "tok", fetchImpl });
    const verdict = await reconcileRelayUnknownSend({ client, ...base });
    expect(verdict).toMatchObject({ status: "unresolved", retryable: false });
  });

  it("returns retryable unresolved on server errors", async () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 503 }));
    const client = createRelayClient({ baseUrl: "https://api.test", token: "tok", fetchImpl });
    const verdict = await reconcileRelayUnknownSend({ client, ...base });
    expect(verdict).toMatchObject({ status: "unresolved", retryable: true });
  });

  it("returns not_sent on deterministic rejections", async () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 404 }));
    const client = createRelayClient({ baseUrl: "https://api.test", token: "tok", fetchImpl });
    const verdict = await reconcileRelayUnknownSend({ client, ...base });
    expect(verdict).toEqual({ status: "not_sent" });
  });

  it("returns non-retryable unresolved on auth failure", async () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 401 }));
    const client = createRelayClient({ baseUrl: "https://api.test", token: "tok", fetchImpl });
    const verdict = await reconcileRelayUnknownSend({ client, ...base });
    expect(verdict).toMatchObject({ status: "unresolved", retryable: false });
  });
});

describe("text chunk ceiling", () => {
  it("keeps any chunk under the server's 8 KiB per-part byte cap", () => {
    // 4 bytes/char is the UTF-8 worst case; the declared char limit must keep
    // even all-astral content within MAX_TEXT_BYTES = 8192.
    expect(RELAY_TEXT_CHUNK_LIMIT * 4).toBeLessThanOrEqual(8 * 1024);
  });
});
