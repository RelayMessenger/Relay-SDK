import { describe, expect, it } from "vitest";
import Relay, { answerMessages } from "../src/index.js";
import { INVOICE_CHECKOUT_HOSTS, invoicePart, parseInvoiceBlock, splitInvoice } from "../src/invoice.js";
import type { MessageInvoiceUpdateParams } from "../src/types.js";

const invoice = {
  type: "invoice" as const,
  title: "House blend, 250 g",
  amount: 2_400,
  currency: "usd",
  goods: "physical" as const,
  url: "https://buy.stripe.com/test_123",
};
const block = (body: unknown) => "```invoice\n" + JSON.stringify(body) + "\n```";

describe("invoicePart", () => {
  it("accepts the whole part and lowercases currency", () => {
    expect(invoicePart({ ...invoice, currency: "USD" })).toEqual(invoice);
  });

  it("trims the title and normalizes recurring", () => {
    expect(invoicePart({ ...invoice, title: "  House blend, 250 g  ", recurring: { interval: "month" } }))
      .toEqual({ ...invoice, recurring: { interval: "month", interval_count: 1 } });
  });

  it("rejects an unknown top-level field", () => {
    expect(invoicePart({ ...invoice, id: "x" })).toBe("invoice has unknown field id");
  });

  it("rejects a type other than invoice", () => {
    expect(invoicePart({ ...invoice, type: "buttons" })).toBe("invoice part needs type invoice");
  });

  it.each([
    [{ ...invoice, title: "" }, `invoice needs a trimmed title of 1 to 32 characters`],
    [{ ...invoice, title: " " }, `invoice needs a trimmed title of 1 to 32 characters`],
    [{ ...invoice, title: "x".repeat(33) }, `invoice needs a trimmed title of 1 to 32 characters`],
    [{ ...invoice, amount: 0 }, "invoice amount must be an integer of 1 to 99999999"],
    [{ ...invoice, amount: 1.5 }, "invoice amount must be an integer of 1 to 99999999"],
    [{ ...invoice, amount: 100_000_000 }, "invoice amount must be an integer of 1 to 99999999"],
    [{ ...invoice, currency: "us" }, "invoice currency must be a 3-letter code"],
    [{ ...invoice, currency: "usdd" }, "invoice currency must be a 3-letter code"],
    [{ ...invoice, goods: "service" }, 'invoice goods must be "physical" or "digital"'],
    [{ ...invoice, url: "x".repeat(2_049) }, "invoice url is not a string of at most 2048 characters"],
    [{ ...invoice, url: "http://buy.stripe.com/test_123" }, "invoice url must be an https Stripe checkout link on checkout.stripe.com, buy.stripe.com, book.stripe.com, donate.stripe.com, invoice.stripe.com"],
    [{ ...invoice, url: "not a url" }, "invoice url must be an https Stripe checkout link on checkout.stripe.com, buy.stripe.com, book.stripe.com, donate.stripe.com, invoice.stripe.com"],
    [{ ...invoice, url: "https://buy.stripe.com@evil.com/x" }, "invoice url must be an https Stripe checkout link on checkout.stripe.com, buy.stripe.com, book.stripe.com, donate.stripe.com, invoice.stripe.com"],
    [{ ...invoice, url: "https://user:pass@buy.stripe.com/x" }, "invoice url must be an https Stripe checkout link on checkout.stripe.com, buy.stripe.com, book.stripe.com, donate.stripe.com, invoice.stripe.com"],
    [{ ...invoice, recurring: "month" }, "invoice recurring must be an object"],
    [{ ...invoice, recurring: { interval: "month", id: "x" } }, "invoice recurring has unknown field id"],
    [{ ...invoice, recurring: { interval: "century" } }, "invoice recurring interval must be day, week, month or year"],
    [{ ...invoice, recurring: { interval: "year", interval_count: 4 } }, "invoice recurring interval_count for year must be an integer of 1 to 3"],
    [{ ...invoice, recurring: { interval: "month", interval_count: 0 } }, "invoice recurring interval_count for month must be an integer of 1 to 36"],
    [null, "the invoice block must be a JSON object"],
    ["invoice", "the invoice block must be a JSON object"],
    [[], "the invoice block must be a JSON object"],
  ])("rejects malformed input %#", (value, error) => {
    expect(invoicePart(value)).toBe(error);
  });

  it("accepts each interval at its own cap", () => {
    expect(invoicePart({ ...invoice, recurring: { interval: "day", interval_count: 1_095 } }))
      .toMatchObject({ recurring: { interval: "day", interval_count: 1_095 } });
    expect(invoicePart({ ...invoice, recurring: { interval: "week", interval_count: 156 } }))
      .toMatchObject({ recurring: { interval: "week", interval_count: 156 } });
    expect(invoicePart({ ...invoice, recurring: { interval: "year", interval_count: 3 } }))
      .toMatchObject({ recurring: { interval: "year", interval_count: 3 } });
  });

  it("counts the title in code points, so a 17-32 character emoji title is not rejected as too long", () => {
    // Each emoji is a surrogate pair: 34 UTF-16 code units but 17 code points.
    expect(invoicePart({ ...invoice, title: "😀".repeat(17) }))
      .toMatchObject({ title: "😀".repeat(17) });
    expect(invoicePart({ ...invoice, title: "😀".repeat(33) }))
      .toBe("invoice needs a trimmed title of 1 to 32 characters");
  });

  it("takes only a Stripe-hosted checkout url, the server's own host list", () => {
    for (const host of INVOICE_CHECKOUT_HOSTS) {
      expect(invoicePart({ ...invoice, url: `https://${host}/test_123` })).toMatchObject({ url: `https://${host}/test_123` });
    }
    for (const url of [
      "https://example.com/pay",
      "https://stripe.com/checkout",
      "https://pay.stripe.com/receipts/x",
      "https://billing.stripe.com/p/session/x",
      "https://buy.stripe.com.evil.com/x",
      "https://buy.stripe.com:8443/x",
    ]) {
      expect(invoicePart({ ...invoice, url })).toBe(
        "invoice url must be an https Stripe checkout link on checkout.stripe.com, buy.stripe.com, book.stripe.com, donate.stripe.com, invoice.stripe.com",
      );
    }
  });

  it("normalizes the checkout url the same way the server stores it", () => {
    expect(invoicePart({ ...invoice, url: "HTTPS://Buy.Stripe.com/test_123" }))
      .toMatchObject({ url: "https://buy.stripe.com/test_123" });
    expect(invoicePart({ ...invoice, url: "https:buy.stripe.com/x" }))
      .toMatchObject({ url: "https://buy.stripe.com/x" });
  });
});

describe("parseInvoiceBlock", () => {
  it("rejects invalid JSON", () => {
    expect(parseInvoiceBlock("{not json")).toBe("the invoice block is not valid JSON");
  });

  it("parses a valid block body", () => {
    expect(parseInvoiceBlock(JSON.stringify(invoice))).toEqual(invoice);
  });
});

describe("splitInvoice", () => {
  it("lifts a fenced invoice block out of the answer and keeps the surrounding words", () => {
    const answer = "Ready to check out?\n\n" + block(invoice);
    expect(splitInvoice(answer)).toEqual({ text: "Ready to check out?", invoice });
  });

  it("keeps text on both sides of the block and collapses the gap", () => {
    const answer = "Before\n" + block(invoice) + "\nAfter";
    expect(splitInvoice(answer).text).toBe("Before\n\nAfter");
  });

  it("returns an invoice-only split when the answer is only the block", () => {
    expect(splitInvoice(block(invoice))).toEqual({ text: "", invoice });
  });

  it("lifts a block written with CRLF line endings", () => {
    const answer = "Pay here:\r\n```invoice\r\n" + JSON.stringify(invoice) + "\r\n```\r\nThanks";
    expect(splitInvoice(answer)).toEqual({ text: "Pay here:\n\nThanks", invoice });
  });

  it("leaves an answer without a block alone, whitespace included", () => {
    expect(splitInvoice("  plain words  ")).toEqual({ text: "  plain words  " });
    expect(splitInvoice("```json\n[1]\n```")).toEqual({ text: "```json\n[1]\n```" });
  });

  it("keeps a malformed block in the text and says why", () => {
    const answer = "Pay here\n" + block("not an invoice");
    expect(splitInvoice(answer)).toEqual({
      text: answer,
      error: "the invoice block must be a JSON object",
    });
  });

  it("rejects more than one invoice block as a conflict", () => {
    const answer = block(invoice) + "\n" + block(invoice);
    expect(splitInvoice(answer)).toEqual({
      text: answer,
      error: "send one invoice and nothing else in the same message",
    });
  });

  it("rejects an invoice alongside a buttons or selection block as a conflict", () => {
    const withButtons = block(invoice) + '\n```buttons\n[{"label": "Yes"}]\n```';
    expect(splitInvoice(withButtons)).toEqual({
      text: withButtons,
      error: "send one invoice and nothing else in the same message",
    });
    const withSelection = block(invoice) + '\n```selection\n[{"value": "a", "label": "A"}]\n```';
    expect(splitInvoice(withSelection)).toEqual({
      text: withSelection,
      error: "send one invoice and nothing else in the same message",
    });
  });
});

describe("answerMessages carries an invoice as its own, final Message", () => {
  it("sends leftover words first, then the invoice alone", () => {
    expect(answerMessages("Ready to check out?\n\n" + block(invoice))).toEqual({
      messages: [
        [{ type: "text", value: "Ready to check out?" }],
        [invoice],
      ],
    });
  });

  it("sends an invoice-only answer as a single Message", () => {
    expect(answerMessages(block(invoice))).toEqual({ messages: [[invoice]] });
  });

  it("still sends a standalone link as its own Message ahead of the invoice", () => {
    const answer = "Here's the order:\nhttps://example.com/cart\n\n" + block(invoice);
    expect(answerMessages(answer)).toEqual({
      messages: [
        [{ type: "text", value: "Here's the order:" }],
        [{ type: "link", value: "https://example.com/cart" }],
        [invoice],
      ],
    });
  });

  it("keeps an invalid invoice block as text without a partial send", () => {
    const answer = "Pay here\n" + block("bad");
    const result = answerMessages(answer);
    expect(result.error).toBe("the invoice block must be a JSON object");
    expect(result.messages).toEqual([[{ type: "text", value: answer }]]);
  });

  it("keeps invoice+buttons conflicts as text, but still sends a standalone link", () => {
    const answer = 'https://example.com/x\n' + block(invoice) + '\n```buttons\n[{"label": "Yes"}]\n```';
    const { messages, error } = answerMessages(answer);
    expect(error).toBe("send one invoice and nothing else in the same message");
    expect(messages.map((parts) => parts.map((part) => part.type))).toEqual([["link"], ["text"]]);
    expect(messages[0]).toEqual([{ type: "link", value: "https://example.com/x" }]);
  });

  it("takes priority over a selection block sharing the same answer", () => {
    const answer = block(invoice) + '\n```selection\n[{"value": "a", "label": "A"}]\n```';
    expect(answerMessages(answer).error).toBe("send one invoice and nothing else in the same message");
  });
});

describe("invoice transport", () => {
  it("serializes an invoice-only message verbatim", async () => {
    const bodies: unknown[] = [];
    const relay = new Relay({
      apiKey: "test", maxRetries: 0,
      fetch: async (_, init) => { bodies.push(JSON.parse(String(init?.body))); return Response.json({}); },
    });
    await relay.chats.messages.send("chat", { message: { parts: [invoice] } });
    expect(bodies).toEqual([{ message: { parts: [invoice] } }]);
  });

  it("updates an invoice's status by message id", async () => {
    const calls: Array<{ path: string; method: string; body: unknown }> = [];
    const relay = new Relay({
      apiKey: "test", baseURL: "https://api.example.test", maxRetries: 0,
      fetch: async (input, init) => {
        calls.push({
          path: new URL(input instanceof Request ? input.url : input).pathname,
          method: init?.method ?? "GET",
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        return Response.json({ message: { id: "message-id", parts: [{ ...invoice, status: "succeeded", reactions: null }] } });
      },
    });
    const params: MessageInvoiceUpdateParams = { status: "succeeded" };
    const result = await relay.messages.invoice.update("message-id", params);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ path: "/v1/messages/message-id/invoice", method: "PUT", body: params });
    expect(result.message.id).toBe("message-id");
  });
});
