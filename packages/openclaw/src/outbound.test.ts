import { Relay } from "@relaymessenger/sdk";
import { describe, expect, it, vi } from "vitest";
import {
  deriveRelayIdempotencyKey,
  sendRelayText,
} from "./outbound.js";

describe("Relay REST Message sends", () => {
  it("uses the Chat Message API with one stable idempotency key", async () => {
    const requests: Array<{
      url: string;
      headers: Headers;
      body: unknown;
    }> = [];
    const relay = new Relay({
      apiKey: "rly_test",
      baseURL: "https://relay.test",
      maxRetries: 0,
      fetch: async (input, init) => {
        requests.push({
          url: String(input),
          headers: new Headers(init?.headers),
          body: JSON.parse(String(init?.body)),
        });
        return Response.json({
          chat_id: "00000000-0000-7000-8000-000000000010",
          message: {
            id: "00000000-0000-7000-8000-000000000011",
            parts: [{ type: "text", value: "Hello", reactions: null }],
            created_at: "2026-09-01T00:00:00.000Z",
            sent_at: "2026-09-01T00:00:00.000Z",
            delivery_status: "sent",
            is_system_message: false,
          },
        });
      },
    });
    const beforeDispatch = vi.fn(async () => {});
    const key = deriveRelayIdempotencyKey({
      deliveryQueueId: "queue-1",
      deliveryPartIndex: 0,
    });

    const response = await sendRelayText({
      relay,
      chatId: "00000000-0000-7000-8000-000000000010",
      text: "Hello",
      replyToId: "00000000-0000-7000-8000-000000000009",
      idempotencyKey: key,
      onPlatformSendDispatch: beforeDispatch,
    });

    expect(response.message.id).toBe(
      "00000000-0000-7000-8000-000000000011",
    );
    expect(beforeDispatch).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      "https://relay.test/v1/chats/" +
        "00000000-0000-7000-8000-000000000010/messages",
    );
    expect(requests[0]?.headers.get("idempotency-key")).toBe(key);
    expect(requests[0]?.body).toEqual({
      message: {
        parts: [{ type: "text", value: "Hello" }],
        idempotency_key: key,
        reply_to: {
          message_id: "00000000-0000-7000-8000-000000000009",
        },
      },
    });
  });

  it("keeps retries stable, separates parts, and keeps intentional sends distinct", () => {
    const first = deriveRelayIdempotencyKey({
      deliveryQueueId: "queue-1",
      deliveryPartIndex: 0,
    });
    expect(
      deriveRelayIdempotencyKey({
        deliveryQueueId: "queue-1",
        deliveryPartIndex: 0,
      }),
    ).toBe(first);
    expect(
      deriveRelayIdempotencyKey({
        deliveryQueueId: "queue-1",
        deliveryPartIndex: 1,
      }),
    ).not.toBe(first);

    const randomValues = ["one", "two"];
    const random = () => randomValues.shift()!;
    expect(deriveRelayIdempotencyKey({ random })).not.toBe(
      deriveRelayIdempotencyKey({ random }),
    );
  });

  it("hashes oversized OpenClaw queue IDs without losing the part identity", () => {
    const queue = "q".repeat(400);
    const first = deriveRelayIdempotencyKey({
      deliveryQueueId: queue,
      deliveryPartIndex: 0,
    });
    const second = deriveRelayIdempotencyKey({
      deliveryQueueId: queue,
      deliveryPartIndex: 1,
    });
    expect(first).toMatch(/^relay-openclaw:sha256:[0-9a-f]{64}$/u);
    expect(first.length).toBeLessThanOrEqual(255);
    expect(second).not.toBe(first);
  });
});
