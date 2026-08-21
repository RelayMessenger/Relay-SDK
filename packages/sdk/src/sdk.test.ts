import { describe, expect, it } from "vitest";
import type { RelayClient } from "./client.js";
import {
  classifyRelayHttpStatus,
  RelayApiError,
  WebhookVerificationError,
} from "./errors.js";
import { replyIdempotencyKey } from "./idempotency.js";
import { MemoryDedupe } from "./memory-dedupe.js";
import { runPollLoop } from "./poll-loop.js";
import { verifyWebhookSignature } from "./signature.js";
import type { MessageReceivedEvent } from "./types.js";
import { normalizeRelayBaseUrl } from "./url.js";
import { createRelayClient } from "./client.js";

describe("normalizeRelayBaseUrl", () => {
  it("defaults to production", () => {
    expect(normalizeRelayBaseUrl()).toBe("https://api.relayapp.im");
  });

  it("rejects http remotes", () => {
    expect(() => normalizeRelayBaseUrl("http://example.com")).toThrow(/HTTPS/);
  });

  it("allows loopback http", () => {
    expect(normalizeRelayBaseUrl("http://127.0.0.1:8787")).toBe(
      "http://127.0.0.1:8787",
    );
  });
});

describe("MemoryDedupe", () => {
  it("records and evicts oldest", () => {
    const dedupe = new MemoryDedupe(2);
    dedupe.record("a");
    dedupe.record("b");
    expect(dedupe.has("a")).toBe(true);
    dedupe.record("c");
    expect(dedupe.has("a")).toBe(false);
    expect(dedupe.has("c")).toBe(true);
  });
});

describe("classifyRelayHttpStatus", () => {
  it("maps status families", () => {
    expect(classifyRelayHttpStatus(401)).toBe("auth");
    expect(classifyRelayHttpStatus(409)).toBe("conflict");
    expect(classifyRelayHttpStatus(429)).toBe("retryable");
    expect(classifyRelayHttpStatus(400)).toBe("rejected");
  });
});

describe("replyIdempotencyKey", () => {
  it("is stable for an event", () => {
    expect(replyIdempotencyKey("evt_1")).toBe("reply-evt_1-0");
  });
});

describe("verifyWebhookSignature", () => {
  it("accepts a valid v1 signature", async () => {
    const secretBytes = crypto.getRandomValues(new Uint8Array(32));
    const secret = `whsec_${btoa(String.fromCharCode(...secretBytes))}`;
    const id = "msg_test";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const payload = '{"event_id":"evt_1"}';
    const key = await crypto.subtle.importKey(
      "raw",
      secretBytes,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(`${id}.${timestamp}.${payload}`),
      ),
    );
    const signature = `v1,${btoa(String.fromCharCode(...sig))}`;
    await expect(
      verifyWebhookSignature({
        secret,
        payload,
        headers: {
          "webhook-id": id,
          "webhook-timestamp": timestamp,
          "webhook-signature": signature,
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects missing headers", async () => {
    await expect(
      verifyWebhookSignature({
        secret: "whsec_YQ==",
        payload: "{}",
        headers: {
          "webhook-id": null,
          "webhook-timestamp": "1",
          "webhook-signature": "v1,YQ==",
        },
      }),
    ).rejects.toBeInstanceOf(WebhookVerificationError);
  });
});

describe("RelayApiError", () => {
  it("exposes terminal auth", () => {
    const error = new RelayApiError("nope", { status: 401, kind: "auth" });
    expect(error.terminal).toBe(true);
    expect(error.retryable).toBe(false);
  });

  it("treats rejected statuses as terminal", () => {
    const error = new RelayApiError("gone", {
      status: 410,
      kind: classifyRelayHttpStatus(410),
    });
    expect(error.terminal).toBe(true);
    expect(error.retryable).toBe(false);
  });
});

describe("RelayClient responding", () => {
  it("still requires an Agent Token for authenticated clients", () => {
    expect(() => createRelayClient({ token: " " })).toThrow(
      /Agent Token is required/,
    );
  });

  it("posts the consumed watermark, label, and invocation", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    const client = createRelayClient({
      token: "rly_test",
      fetchImpl: async (input, init) => {
        requests.push({
          url: input,
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        return new Response(null, { status: 204 });
      },
    });

    await client.setResponding({
      conversationId: "cnv/a",
      messageId: "msg_2",
      label: "Claude Code",
      invocationId: "inv_1",
    });

    expect(requests).toEqual([
      {
        url: "https://api.relayapp.im/v1/conversations/cnv%2Fa/responding",
        body: {
          message_id: "msg_2",
          label: "Claude Code",
          invocation_id: "inv_1",
        },
      },
    ]);
  });
});

describe("runPollLoop", () => {
  const baseParams = {
    getCursor: () => 0,
    setCursor: () => {},
    dedupe: new MemoryDedupe(),
    onMessage: () => {},
  };

  it("throws on a 410 cursor_expired instead of retrying", async () => {
    let polls = 0;
    const client = {
      pollEvents: async () => {
        polls += 1;
        throw new RelayApiError("cursor expired", {
          status: 410,
          kind: classifyRelayHttpStatus(410),
          code: "cursor_expired",
        });
      },
    } as unknown as RelayClient;
    await expect(
      runPollLoop({ ...baseParams, client }),
    ).rejects.toMatchObject({ status: 410 });
    expect(polls).toBe(1);
  });

  it("throws on a 422 cursor-ahead error instead of retrying", async () => {
    let polls = 0;
    const client = {
      pollEvents: async () => {
        polls += 1;
        throw new RelayApiError("cursor ahead", {
          status: 422,
          kind: classifyRelayHttpStatus(422),
          code: "invalid_request",
          details: { highest_delivered_cursor: 41 },
        });
      },
    } as unknown as RelayClient;
    await expect(
      runPollLoop({ ...baseParams, client }),
    ).rejects.toMatchObject({
      status: 422,
      details: { highest_delivered_cursor: 41 },
    });
    expect(polls).toBe(1);
  });

  it("sends plain replies by default and quotes only on request", async () => {
    const sends: Array<Record<string, unknown>> = [];
    const abort = new AbortController();
    const event: MessageReceivedEvent = {
      event_id: "evt_1",
      event_type: "message.received",
      agent_id: "agt_1",
      created_at: "2026-08-16T00:00:00.000Z",
      data: {
        message: {
          id: "msg_1",
          conversation_id: "cnv_1",
          sequence: 1,
          sender: { kind: "user", id: "usr_1" },
          parts: [{ type: "text", part_index: 0, text: "hi" }],
          created_at: "2026-08-16T00:00:00.000Z",
        },
      },
    };
    const client = {
      pollEvents: async () => ({ events: [event], nextCursor: 1 }),
      sendText: async (params: Record<string, unknown>) => {
        sends.push(params);
        return { messages: [event.data.message] };
      },
    } as unknown as RelayClient;

    await runPollLoop({
      ...baseParams,
      client,
      abortSignal: abort.signal,
      onMessage: async (ctx) => {
        await ctx.reply.text("plain");
        await ctx.reply.text("quoted", { quote: true });
        abort.abort();
      },
    });

    expect(sends).toHaveLength(2);
    expect(sends[0]).not.toHaveProperty("replyTo");
    // Replies target a message id only; the wire carries no part_index.
    expect(sends[1]?.replyTo).toEqual({ message_id: "msg_1" });
  });
});
