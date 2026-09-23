import { describe, expect, it } from "vitest";
import Relay, { answerMessages } from "../src/index.js";
import { PAYMENT_CHECKOUT_URL_MAX_LENGTH, parsePaymentBlock, paymentPart, splitPayment } from "../src/payment.js";
import type { PaymentPartResponse, PaymentReceiptPartResponse, PaymentRequest, PaymentWebhookEvent } from "../src/types.js";

const payment = { type: "payment" as const, checkout_url: "https://pay.relayapp.im/pr_token_123" };
const block = (body: unknown) => "```payment\n" + JSON.stringify(body) + "\n```";

describe("paymentPart", () => {
  it("accepts the whole part or only its checkout_url", () => {
    expect(paymentPart(payment)).toEqual(payment);
    expect(paymentPart({ checkout_url: payment.checkout_url })).toEqual(payment);
  });

  it("passes the checkout_url through unchanged, since only the server knows which request it names", () => {
    const url = "https://pay.staging.relayapp.im/Tok?x=1";
    expect(paymentPart({ checkout_url: url })).toEqual({ type: "payment", checkout_url: url });
  });

  it.each([
    [{ ...payment, amount: 2_400 }, "payment has unknown field amount"],
    [{ ...payment, type: "buttons" }, "payment part needs type payment"],
    [{ type: "payment" }, "payment needs the checkout_url of a payment request, at most 2048 characters"],
    [{ checkout_url: "" }, "payment needs the checkout_url of a payment request, at most 2048 characters"],
    [{ checkout_url: 7 }, "payment needs the checkout_url of a payment request, at most 2048 characters"],
    [{ checkout_url: "x".repeat(PAYMENT_CHECKOUT_URL_MAX_LENGTH + 1) }, "payment needs the checkout_url of a payment request, at most 2048 characters"],
    [null, "the payment block must be a JSON object"],
    ["payment", "the payment block must be a JSON object"],
    [[], "the payment block must be a JSON object"],
  ])("rejects malformed input %#", (value, error) => {
    expect(paymentPart(value)).toBe(error);
  });

  it("accepts a checkout_url at the server's length cap", () => {
    const url = "https://pay.relayapp.im/" + "x".repeat(PAYMENT_CHECKOUT_URL_MAX_LENGTH - 24);
    expect(url).toHaveLength(PAYMENT_CHECKOUT_URL_MAX_LENGTH);
    expect(paymentPart({ checkout_url: url })).toEqual({ type: "payment", checkout_url: url });
  });
});

describe("parsePaymentBlock", () => {
  it("rejects invalid JSON", () => {
    expect(parsePaymentBlock("{not json")).toBe("the payment block is not valid JSON");
  });

  it("parses a valid block body", () => {
    expect(parsePaymentBlock(JSON.stringify({ checkout_url: payment.checkout_url }))).toEqual(payment);
  });
});

describe("splitPayment", () => {
  it("lifts a fenced payment block out of the answer and keeps the surrounding words", () => {
    const answer = "Ready to check out?\n\n" + block(payment);
    expect(splitPayment(answer)).toEqual({ text: "Ready to check out?", payment });
  });

  it("keeps text on both sides of the block and collapses the gap", () => {
    expect(splitPayment("Before\n" + block(payment) + "\nAfter").text).toBe("Before\n\nAfter");
  });

  it("returns a payment-only split when the answer is only the block", () => {
    expect(splitPayment(block(payment))).toEqual({ text: "", payment });
  });

  it("lifts a block written with CRLF line endings", () => {
    const answer = "Pay here:\r\n```payment\r\n" + JSON.stringify(payment) + "\r\n```\r\nThanks";
    expect(splitPayment(answer)).toEqual({ text: "Pay here:\n\nThanks", payment });
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
    const twice = block(payment) + "\n" + block(payment);
    expect(splitPayment(twice)).toEqual({ text: twice, error });
    const withButtons = block(payment) + '\n```buttons\n[{"label": "Yes"}]\n```';
    expect(splitPayment(withButtons)).toEqual({ text: withButtons, error });
    const withSelection = block(payment) + '\n```selection\n[{"value": "a", "label": "A"}]\n```';
    expect(splitPayment(withSelection)).toEqual({ text: withSelection, error });
  });
});

describe("answerMessages carries a payment as its own, final Message", () => {
  it("sends leftover words first, then the payment alone", () => {
    expect(answerMessages("Ready to check out?\n\n" + block(payment))).toEqual({
      messages: [[{ type: "text", value: "Ready to check out?" }], [payment]],
    });
  });

  it("sends a payment-only answer as a single Message", () => {
    expect(answerMessages(block(payment))).toEqual({ messages: [[payment]] });
  });

  it("still sends a standalone link as its own Message ahead of the payment", () => {
    const answer = "Here's the order:\nhttps://example.com/cart\n\n" + block(payment);
    expect(answerMessages(answer)).toEqual({
      messages: [
        [{ type: "text", value: "Here's the order:" }],
        [{ type: "link", value: "https://example.com/cart" }],
        [payment],
      ],
    });
  });

  it("keeps an invalid payment block as text without a partial send", () => {
    const answer = "Pay here\n" + block("bad");
    const result = answerMessages(answer);
    expect(result.error).toBe("the payment block must be a JSON object");
    expect(result.messages).toEqual([[{ type: "text", value: answer }]]);
  });

  it("keeps payment+buttons conflicts as text, but still sends a standalone link", () => {
    const answer = "https://example.com/x\n" + block(payment) + '\n```buttons\n[{"label": "Yes"}]\n```';
    const { messages, error } = answerMessages(answer);
    expect(error).toBe("send one payment and nothing else in the same message");
    expect(messages.map((parts) => parts.map((part) => part.type))).toEqual([["link"], ["text"]]);
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
