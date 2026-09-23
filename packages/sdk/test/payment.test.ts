import { describe, expect, it } from "vitest";
import Relay, { answerMessages, RelayAPIError } from "../src/index.js";
import { createPaymentPart, parsePaymentBlock, paymentRequestFields, PAYMENT_GUIDANCE, splitPayment } from "../src/payment.js";
import type { PaymentPartResponse, PaymentReceiptPartResponse, PaymentRequest, PaymentWebhookEvent } from "../src/types.js";

const fields = { description: "House blend, 250 g", category: "physical_goods" as const, amount: 2_400, currency: "usd" };
const payment = { type: "payment" as const, checkout_url: "https://pay.relayapp.im/pr_token_123" };
const block = (body: unknown) => "```payment\n" + JSON.stringify(body) + "\n```";

describe("PAYMENT_GUIDANCE", () => {
  it("names each category on its own line", () => {
    expect(PAYMENT_GUIDANCE).toContain("category physical_goods: physical things and real-world services.");
    expect(PAYMENT_GUIDANCE).toContain("category digital_goods: digital content and tips.");
    expect(PAYMENT_GUIDANCE).toContain("category donation: a charity or a fundraiser.");
  });
});

describe("paymentRequestFields", () => {
  it("accepts a one-time payment, trims the description and lowercases the currency", () => {
    expect(paymentRequestFields({ ...fields, description: "  House blend, 250 g  ", currency: "USD" })).toEqual(fields);
  });

  it("accepts a subscription from a price, with an optional quantity and picture", () => {
    const subscription = { description: "Monthly plan", category: "digital_goods", mode: "subscription", price_id: "price_123", quantity: 2, image_url: "https://example.com/plan.png" };
    expect(paymentRequestFields(subscription)).toEqual(subscription);
  });

  it("counts the description in code points, the server's own measure", () => {
    const title = "\u{1F600}".repeat(32);
    expect(paymentRequestFields({ ...fields, description: title })).toEqual({ ...fields, description: title });
  });

  it.each([
    [{ ...fields, checkout_url: "https://pay.relayapp.im/x" }, "payment has unknown field checkout_url"],
    [{ ...fields, metadata: {} }, "payment has unknown field metadata"],
    [{ ...fields, description: " " }, "payment needs a description of 1 to 32 characters"],
    [{ ...fields, description: "x".repeat(33) }, "payment needs a description of 1 to 32 characters"],
    [{ ...fields, category: "service" }, "payment category must be physical_goods, digital_goods, donation"],
    [{ ...fields, mode: "one_time" }, "payment mode must be payment or subscription"],
    [{ ...fields, amount: 0 }, "payment amount must be a whole number of minor units, at least 1"],
    [{ ...fields, amount: 1.5 }, "payment amount must be a whole number of minor units, at least 1"],
    [{ ...fields, currency: "usdd" }, "payment currency must be a 3-letter code"],
    [{ ...fields, price_id: "price_1" }, "price_id and quantity are for mode subscription"],
    [{ ...fields, mode: "subscription", price_id: "price_1" }, "a subscription takes its amount and currency from price_id; omit amount and currency"],
    [{ description: "Plan", category: "digital_goods", mode: "subscription" }, "a subscription needs a price_id"],
    [{ description: "Plan", category: "digital_goods", mode: "subscription", price_id: "price_1", quantity: 0 }, "payment quantity must be a whole number of at least 1"],
    [{ ...fields, image_url: "http://example.com/a.png" }, "payment image_url must be an https address of at most 2048 characters"],
    [null, "the payment block must be a JSON object"],
    [[], "the payment block must be a JSON object"],
  ])("rejects malformed input %#", (value, error) => {
    expect(paymentRequestFields(value)).toBe(error);
  });
});

describe("parsePaymentBlock", () => {
  it("rejects invalid JSON", () => {
    expect(parsePaymentBlock("{not json")).toBe("the payment block is not valid JSON");
  });

  it("parses a valid block body", () => {
    expect(parsePaymentBlock(JSON.stringify(fields))).toEqual(fields);
  });
});

describe("splitPayment", () => {
  it("lifts a fenced payment block out of the answer and keeps the surrounding words", () => {
    expect(splitPayment("Ready to check out?\n\n" + block(fields))).toEqual({ text: "Ready to check out?", payment: fields });
  });

  it("keeps text on both sides of the block and collapses the gap", () => {
    expect(splitPayment("Before\n" + block(fields) + "\nAfter").text).toBe("Before\n\nAfter");
  });

  it("lifts a block written with CRLF line endings", () => {
    const answer = "Pay here:\r\n```payment\r\n" + JSON.stringify(fields) + "\r\n```\r\nThanks";
    expect(splitPayment(answer)).toEqual({ text: "Pay here:\n\nThanks", payment: fields });
  });

  it("leaves an answer without a block alone, a payment_receipt fence included", () => {
    expect(splitPayment("  plain words  ")).toEqual({ text: "  plain words  " });
    const receipt = "```payment_receipt\n{}\n```";
    expect(splitPayment(receipt)).toEqual({ text: receipt });
  });

  it("keeps a malformed block in the text and says why", () => {
    const answer = "Pay here\n" + block("not a payment");
    expect(splitPayment(answer)).toEqual({ text: answer, error: "the payment block must be a JSON object" });
  });

  it("rejects more than one payment block, or one beside buttons or selection, as a conflict", () => {
    const error = "send one payment and nothing else in the same message";
    const twice = block(fields) + "\n" + block(fields);
    expect(splitPayment(twice)).toEqual({ text: twice, error });
    const withButtons = block(fields) + '\n```buttons\n[{"label": "Yes"}]\n```';
    expect(splitPayment(withButtons)).toEqual({ text: withButtons, error });
    const withSelection = block(fields) + '\n```selection\n[{"value": "a", "label": "A"}]\n```';
    expect(splitPayment(withSelection)).toEqual({ text: withSelection, error });
  });
});

describe("answerMessages returns the payment request beside the words", () => {
  it("sends leftover words as Messages and hands the request back for the bridge to create", () => {
    expect(answerMessages("Ready to check out?\n\n" + block(fields))).toEqual({
      messages: [[{ type: "text", value: "Ready to check out?" }]],
      payment: fields,
    });
  });

  it("returns no Messages for a payment-only answer", () => {
    expect(answerMessages(block(fields))).toEqual({ messages: [], payment: fields });
  });

  it("still sends a standalone link as its own Message ahead of the payment", () => {
    const answer = "Here's the order:\nhttps://example.com/cart\n\n" + block(fields);
    expect(answerMessages(answer)).toEqual({
      messages: [
        [{ type: "text", value: "Here's the order:" }],
        [{ type: "link", value: "https://example.com/cart" }],
      ],
      payment: fields,
    });
  });

  it("keeps an invalid payment block as text without a partial send", () => {
    const answer = "Pay here\n" + block("bad");
    const result = answerMessages(answer);
    expect(result.error).toBe("the payment block must be a JSON object");
    expect(result.payment).toBeUndefined();
    expect(result.messages).toEqual([[{ type: "text", value: answer }]]);
  });

  it("keeps payment+buttons conflicts as text, but still sends a standalone link", () => {
    const answer = "https://example.com/x\n" + block(fields) + '\n```buttons\n[{"label": "Yes"}]\n```';
    const { messages, error } = answerMessages(answer);
    expect(error).toBe("send one payment and nothing else in the same message");
    expect(messages.map((parts) => parts.map((part) => part.type))).toEqual([["link"], ["text"]]);
  });
});

describe("createPaymentPart", () => {
  it("creates the request on the card's key and returns the payment part carrying it", async () => {
    const calls: Array<{ body: unknown; key: string | null }> = [];
    const relay = new Relay({ apiKey: "test", maxRetries: 0, fetch: async (_, init) => {
      calls.push({ body: JSON.parse(String(init?.body)), key: new Headers(init?.headers).get("idempotency-key") });
      return Response.json({ checkout_url: payment.checkout_url }, { status: 201 });
    } });
    await expect(createPaymentPart(relay, fields, "answer-1")).resolves.toEqual(payment);
    expect(calls).toEqual([{ body: fields, key: "answer-1" }]);
  });

  it("throws a refusal as the API error for the bridge to hand back", async () => {
    const relay = new Relay({ apiKey: "test", maxRetries: 0, fetch: async () =>
      Response.json({ error: { code: 2003, message: "Connect Stripe in the Relay Console first." } }, { status: 403 }) });
    const refusal = await createPaymentPart(relay, fields, "answer-1").catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(RelayAPIError);
    expect((refusal as RelayAPIError).status).toBe(403);
  });
});

const request: PaymentRequest = {
  id: "0199a000-0000-7000-8000-000000000001",
  object: "payment_request",
  status: "requested",
  mode: "payment",
  amount: 2_400,
  currency: "usd",
  description: "House blend, 250 g",
  category: "physical_goods",
  checkout_url: payment.checkout_url,
  expires_at: "2026-09-24T12:00:00.000Z",
  metadata: { order: "42" },
  stripe: { payment_intent_id: "pi_123" },
  created_at: "2026-09-23T13:00:00.000Z",
  updated_at: "2026-09-23T13:00:00.000Z",
};

describe("payment transport", () => {
  const recorder = (response: unknown) => {
    const calls: Array<{ path: string; method: string; body: unknown; key: string | null }> = [];
    const relay = new Relay({
      apiKey: "test", baseURL: "https://api.example.test", maxRetries: 0,
      fetch: async (input, init) => {
        calls.push({
          path: new URL(input instanceof Request ? input.url : input).pathname,
          method: init?.method ?? "GET",
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
          key: new Headers(init?.headers).get("idempotency-key"),
        });
        return Response.json(response);
      },
    });
    return { relay, calls };
  };

  it("serializes a payment-only message verbatim", async () => {
    const { relay, calls } = recorder({});
    await relay.chats.messages.send("chat", { message: { parts: [payment] } });
    expect(calls.map((call) => call.body)).toEqual([{ message: { parts: [payment] } }]);
  });

  it("creates a payment request with its Idempotency-Key and returns the request", async () => {
    const { relay, calls } = recorder(request);
    const created = await relay.paymentRequests.create(
      { amount: 2_400, currency: "usd", description: "House blend, 250 g", category: "physical_goods", metadata: { order: "42" } },
      { idempotencyKey: "order-42" },
    );
    expect(calls).toEqual([{
      path: "/v1/payment_requests", method: "POST", key: "order-42",
      body: { amount: 2_400, currency: "usd", description: "House blend, 250 g", category: "physical_goods", metadata: { order: "42" } },
    }]);
    expect(created.checkout_url).toBe(payment.checkout_url);
  });

  it("sends no Idempotency-Key when none is given", async () => {
    const { relay, calls } = recorder(request);
    await relay.paymentRequests.create({ description: "Monthly plan", category: "digital_goods", mode: "subscription", price_id: "price_123" });
    expect(calls[0]).toMatchObject({ path: "/v1/payment_requests", method: "POST", key: null });
  });

  it("cancels a payment request by id", async () => {
    const { relay, calls } = recorder({ ...request, status: "canceled" });
    const canceled = await relay.paymentRequests.cancel(request.id);
    expect(calls).toEqual([{ path: `/v1/payment_requests/${request.id}/cancel`, method: "POST", body: {}, key: null }]);
    expect(canceled.status).toBe("canceled");
  });
});

describe("payment read-back types", () => {
  it("carries the request's fields on the card, the receipt and the webhook", () => {
    const card: PaymentPartResponse = {
      type: "payment", payment_request_id: request.id, checkout_url: request.checkout_url,
      amount: 900, currency: "usd", description: "Monthly plan", category: "digital_goods",
      mode: "subscription", recurring: { interval: "month", interval_count: 1 }, status: "requested", reactions: null,
    };
    const receipt: PaymentReceiptPartResponse = {
      type: "payment_receipt", payment_request_id: request.id, description: "Monthly plan",
      amount: 900, currency: "usd", mode: "subscription", recurring: { interval: "month", interval_count: 1 }, reactions: null,
    };
    const event: PaymentWebhookEvent = {
      api_version: "v1", webhook_version: "2026-08-30", event_type: "payment.succeeded",
      event_id: "0199a000-0000-7000-8000-000000000002", created_at: request.created_at,
      trace_id: "trace", agent_id: "0199a000-0000-7000-8000-000000000003",
      data: { ...request, status: "succeeded", paid_at: "2026-09-23T13:05:00.000Z" },
    };
    expect([card.type, receipt.type, event.data.status]).toEqual(["payment", "payment_receipt", "succeeded"]);
  });
});
