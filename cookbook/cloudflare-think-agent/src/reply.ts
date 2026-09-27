import { action, type Action } from "@cloudflare/think";
import type { RelayAdapter } from "@relaymessenger/chat-sdk-adapter";
import { encodeRelayThreadId } from "@relaymessenger/chat-sdk-adapter";
import {
  PAYMENT_CATEGORIES,
  PAYMENT_DESCRIPTION_MAX_LENGTH,
  PAYMENT_GUIDANCE,
  PAYMENT_IMAGE_URL_MAX_LENGTH,
  paymentRequestFields,
  type PaymentRequestCreateParams,
} from "@relaymessenger/sdk";
import { z } from "zod";

// The fields a model can know, as POST /v1/payment_requests takes them.
// `paymentRequestFields` from the SDK is the check; this schema is what the
// model reads, the same one the Claude Code reply tool publishes.
const paymentSchema = z.object({
  description: z.string().min(1).max(PAYMENT_DESCRIPTION_MAX_LENGTH),
  category: z.enum(PAYMENT_CATEGORIES),
  amount: z.number().int().min(1).optional()
    .describe("Minor units, e.g. 2400 for 24.00. Not with mode subscription."),
  currency: z.string().regex(/^[A-Za-z]{3}$/u).optional()
    .describe("3-letter ISO currency code. Not with mode subscription."),
  mode: z.enum(["payment", "subscription"]).optional(),
  price_id: z.string().min(1).optional()
    .describe("Mode subscription: a recurring Stripe price"),
  quantity: z.number().int().min(1).optional()
    .describe("Mode subscription: units of the price"),
  image_url: z.string().max(PAYMENT_IMAGE_URL_MAX_LENGTH).optional()
    .describe("An https picture of the product"),
}).strict().describe(
  "Ask the person to pay. Relay creates the payment with your Stripe account "
  + "and sends its card as its own Message after the text. "
  + PAYMENT_GUIDANCE,
);

const replySchema = z.object({
  text: z.string().trim().min(1).max(10_000).optional(),
  payment: paymentSchema.optional(),
}).strict().refine(
  (reply) => reply.text !== undefined || reply.payment !== undefined,
  { message: "reply needs text, a payment, or both" },
);

export interface RelayTurnIdentity {
  chatId: string;
  messageId: string;
}

interface ReplyDependencies {
  adapter(): RelayAdapter;
  turn(): RelayTurnIdentity;
}

export function relayReplyIdempotencyKey(messageId: string): string {
  return `relay-agent-starter:${messageId}`;
}

/**
 * The payment request's key: the inbound Message that caused it, plus the
 * fields the model gave. A retry of the same answer returns the same request;
 * corrected fields after a refusal are a new request, as Claude Code's new
 * send_id is.
 */
export async function relayPaymentIdempotencyKey(
  messageId: string,
  fields: PaymentRequestCreateParams,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(fields)),
  );
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${relayReplyIdempotencyKey(messageId)}:payment:${hex}`;
}

/**
 * Thrown when Relay did not create the payment request. Nothing was sent, so
 * the error goes back to the model as the reply Action's result and the model
 * answers again. `RELAY_PAYMENT_NOT_CREATED` is how the turn tells this apart
 * from every other reply failure.
 */
export const RELAY_PAYMENT_NOT_CREATED = "RelayPaymentNotCreated";

export class RelayPaymentNotCreatedError extends Error {
  override readonly name = RELAY_PAYMENT_NOT_CREATED;
}

export type RelayReplyResult =
  | { messageId: string; paymentMessageId?: string; status: "sent" }
  | { status: "aborted" };

export interface RelayReply {
  text?: string;
  payment?: unknown;
}

/**
 * Commit the answer through the adapter's own client: the words as one Relay
 * Message, then any payment card as its own Message after them.
 *
 * The adapter is the only Relay client in the Worker, so every send shares its
 * `fetch` override, its credential resolver and its inbound-event idempotency
 * keys. The payment request is created before anything is sent, so a refusal
 * reaches the model with nothing half-sent.
 */
export async function sendRelayReply(
  adapter: RelayAdapter,
  turn: RelayTurnIdentity,
  reply: string | RelayReply,
  signal?: AbortSignal,
): Promise<RelayReplyResult> {
  const { text, payment } =
    typeof reply === "string" ? { text: reply, payment: undefined } : reply;
  const fields = payment === undefined ? undefined : paymentRequestFields(payment);
  if (typeof fields === "string") {
    throw new RelayPaymentNotCreatedError(
      `payment: ${fields}. Nothing was sent; call reply again with the payment fixed or without it.`,
    );
  }
  // A superseded turn must not commit its answer. Relay has no unsend, so the
  // signal is checked at the last moment before the message becomes real.
  if (signal?.aborted) return { status: "aborted" };

  let card: { type: "payment"; checkout_url: string } | undefined;
  if (fields) {
    try {
      const request = await adapter.client.createPaymentRequest(fields, {
        idempotencyKey: await relayPaymentIdempotencyKey(turn.messageId, fields),
      });
      card = { type: "payment", checkout_url: request.checkout_url };
    } catch (error) {
      // A 403 until Stripe is connected, Stripe's own 400, or a temporary
      // failure: the model reads which, and the same fields reuse the key.
      throw new RelayPaymentNotCreatedError(
        `payment request not created: ${error instanceof Error ? error.message : String(error)}. `
        + "Nothing was sent; call reply again with the payment fixed, unchanged if the failure was temporary, or without it.",
      );
    }
    if (signal?.aborted) return { status: "aborted" };
  }

  const threadId = encodeRelayThreadId({ chatId: turn.chatId });
  const sent = text
    ? await adapter.postMessage(threadId, { markdown: text })
    : undefined;
  const paid = card
    ? await adapter.postMessageParts(threadId, [card])
    : undefined;
  const messageId = (sent ?? paid)!.id;
  return {
    messageId,
    ...(sent && paid ? { paymentMessageId: paid.id } : {}),
    status: "sent",
  };
}

export function createReplyAction(deps: ReplyDependencies): Action {
  return action({
    description:
      "Send the complete response as one canonical Relay Message, and any "
      + "payment as its own card after it. Call this exactly once.",
    inputSchema: replySchema,
    idempotencyKey: () => `message:${deps.turn().messageId}`,
    execute: (reply, context) =>
      sendRelayReply(
        deps.adapter(),
        deps.turn(),
        reply,
        context.signal,
      ),
  });
}
