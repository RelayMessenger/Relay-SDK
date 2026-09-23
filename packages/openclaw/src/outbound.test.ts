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

  it("lifts a fenced buttons block out of the agent's words into a buttons part", async () => {
    const requests: Array<{ body: unknown }> = [];
    const relay = new Relay({
      apiKey: "token",
      baseURL: "https://relay.test",
      maxRetries: 0,
      fetch: async (_input, init) => {
        requests.push({ body: JSON.parse(String(init?.body)) });
        return Response.json({ message: { id: "00000000-0000-7000-8000-000000000012" } }, { status: 202 });
      },
    });
    const errors: string[] = [];
    await sendRelayText({
      relay,
      chatId: "00000000-0000-7000-8000-000000000010",
      text: "Which slot?\n\n```buttons\n[{\"label\": \"9am\"}, {\"label\": \"2pm\"}]\n```",
      idempotencyKey: "key-1",
      onButtonsError: (error) => errors.push(error),
    });
    expect(errors).toEqual([]);
    expect(requests[0]?.body).toEqual({
      message: {
        parts: [
          { type: "text", value: "Which slot?" },
          { type: "buttons", items: [{ label: "9am" }, { label: "2pm" }] },
        ],
        idempotency_key: "key-1",
      },
    });

    await sendRelayText({
      relay,
      chatId: "00000000-0000-7000-8000-000000000010",
      text: "Pick\n\n```buttons\n[]\n```",
      idempotencyKey: "key-2",
      onButtonsError: (error) => errors.push(error),
    });
    expect(errors).toEqual(["the buttons block has no items"]);
    expect(requests[1]?.body).toEqual({
      message: {
        parts: [{ type: "text", value: "Pick\n\n```buttons\n[]\n```" }],
        idempotency_key: "key-2",
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

describe("links in the agent's words", () => {
  it("sends a URL alone on a line as its own link Message, keyed by index, with the reply anchor on the first", async () => {
    const requests: Array<{ body: unknown }> = [];
    const relay = new Relay({
      apiKey: "token",
      baseURL: "https://relay.test",
      maxRetries: 0,
      fetch: async (_input, init) => {
        requests.push({ body: JSON.parse(String(init?.body)) });
        return Response.json({ message: { id: `00000000-0000-7000-8000-00000000001${requests.length}` } }, { status: 202 });
      },
    });
    const response = await sendRelayText({
      relay,
      chatId: "00000000-0000-7000-8000-000000000010",
      text: "Here it is:\nhttps://example.com/story",
      replyToId: "00000000-0000-7000-8000-000000000099",
      idempotencyKey: "key-1",
    });
    expect(requests.map((request) => request.body)).toEqual([
      {
        message: {
          parts: [{ type: "text", value: "Here it is:" }],
          idempotency_key: "key-1",
          reply_to: { message_id: "00000000-0000-7000-8000-000000000099" },
        },
      },
      {
        message: {
          parts: [{ type: "link", value: "https://example.com/story" }],
          idempotency_key: "key-1-1",
        },
      },
    ]);
    expect(response.message.id).toBe("00000000-0000-7000-8000-000000000011");
  });
});

it("sends a real selection part from a selection fence with the existing idempotency key", async () => {
  const requests: unknown[] = [];
  const relay = new Relay({ apiKey: "test", fetch: async (_, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return Response.json({ message: { id: "sent" } }, { status: 202 });
  } });
  await sendRelayText({ relay, chatId: "chat", text: 'Topics?\n```selection\n[{"value":"research","label":"Research"}]\n```', idempotencyKey: "selection-operation" });
  expect(requests).toEqual([{ message: { parts: [
    { type: "text", value: "Topics?" }, { type: "selection", options: [{ value: "research", label: "Research" }] },
  ], idempotency_key: "selection-operation" } }]);
});

it("sends a payment fence as its own final Message after the words, with the reply anchor on the words", async () => {
  const requests: unknown[] = [];
  const created: Array<{ body: unknown; key: string | null }> = [];
  const relay = new Relay({ apiKey: "test", fetch: async (input, init) => {
    if (String(input).endsWith("/v1/payment_requests")) {
      created.push({ body: JSON.parse(String(init?.body)), key: new Headers(init?.headers).get("idempotency-key") });
      return Response.json({ checkout_url: "https://pay.relayapp.im/pr_token_123" }, { status: 201 });
    }
    requests.push(JSON.parse(String(init?.body)));
    return Response.json({ message: { id: `sent-${requests.length}` } }, { status: 202 });
  } });
  const response = await sendRelayText({ relay, chatId: "chat", replyToId: "source", idempotencyKey: "payment-operation", text:
    'Here is your order.\n```payment\n{"description":"House blend, 250 g","category":"physical_goods","amount":2400,"currency":"usd"}\n```' });
  expect(requests).toEqual([
    { message: { parts: [{ type: "text", value: "Here is your order." }], idempotency_key: "payment-operation", reply_to: { message_id: "source" } } },
    { message: { parts: [
      { type: "payment", checkout_url: "https://pay.relayapp.im/pr_token_123" },
    ], idempotency_key: "payment-operation-1" } },
  ]);
  expect(created).toEqual([{
    body: { description: "House blend, 250 g", category: "physical_goods", amount: 2400, currency: "usd" },
    key: "payment-operation-1",
  }]);
  expect(response.message.id).toBe("sent-1");
});

it("anchors the reply on the payment when the answer is only a payment fence", async () => {
  const requests: unknown[] = [];
  const relay = new Relay({ apiKey: "test", fetch: async (input, init) => {
    if (String(input).endsWith("/v1/payment_requests")) {
      return Response.json({ checkout_url: "https://pay.relayapp.im/pr_token_123" }, { status: 201 });
    }
    requests.push(JSON.parse(String(init?.body)));
    return Response.json({ message: { id: "sent" } }, { status: 202 });
  } });
  await sendRelayText({ relay, chatId: "chat", replyToId: "source", idempotencyKey: "payment-only", text:
    '```payment\n{"description":"House blend, 250 g","category":"physical_goods","amount":2400,"currency":"usd"}\n```' });
  expect(requests).toEqual([{ message: { parts: [
    { type: "payment", checkout_url: "https://pay.relayapp.im/pr_token_123" },
  ], idempotency_key: "payment-only", reply_to: { message_id: "source" } } }]);
});

it("keeps the words and reports a refused payment request instead of sending a card", async () => {
  const requests: unknown[] = [];
  const errors: string[] = [];
  const relay = new Relay({ apiKey: "test", maxRetries: 0, fetch: async (input, init) => {
    if (String(input).endsWith("/v1/payment_requests")) {
      return Response.json({ error: { code: 2003, message: "Connect Stripe in the Relay Console first." } }, { status: 403 });
    }
    requests.push(JSON.parse(String(init?.body)));
    return Response.json({ message: { id: "sent" } }, { status: 202 });
  } });
  await sendRelayText({ relay, chatId: "chat", idempotencyKey: "payment-refused", onButtonsError: (error) => errors.push(error), text:
    'Here is your order.\n```payment\n{"description":"House blend, 250 g","category":"physical_goods","amount":2400,"currency":"usd"}\n```' });
  expect(requests).toEqual([{ message: { parts: [{ type: "text", value: "Here is your order." }], idempotency_key: "payment-refused" } }]);
  expect(errors).toEqual(["the payment was not sent: Connect Stripe in the Relay Console first."]);
});
