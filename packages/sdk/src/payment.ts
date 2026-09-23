import type { PaymentPart } from "./types.js";

/**
 * The fence tag a text-only agent uses to send a payment card. The block body
 * is one JSON object, the `payment` part exactly as the API takes it:
 *
 * ```payment
 * {"checkout_url": "https://pay.relayapp.im/..."}
 * ```
 */
export const PAYMENT_FENCE = "payment";

/**
 * When and how an agent asks someone to pay. One text, carried verbatim by
 * every runtime's tool description or prompt. The flow is the server's: a
 * payment request on the organization's connected Stripe account returns
 * `checkout_url`, and a `payment` part carrying it draws the card (Linq Agent
 * Pay: `POST /v3/payment_requests`, then the card; the card's amount is read
 * from the request, never from the sender). The categories are the contract's
 * `PaymentCategory`, which cites Apple 3.1.3(e), 3.1.1(a) and 3.2.2(iv).
 */
export const PAYMENT_GUIDANCE = [
  "Ask a person to pay only when they asked to buy something or have already agreed to a price.",
  "First create a payment request (POST /v1/payment_requests) with a description of 1 to 32 characters, a category, and an amount in minor units plus a currency, or mode subscription with a price_id; it returns checkout_url, Relay's pay page on your organization's own connected Stripe account.",
  "Then send that checkout_url unchanged as a payment part; the card reads its amount and title from the request.",
  "Set category honestly: physical_goods for goods and services used in the real world, digital_goods for anything used in an app or online (payable only on the United States storefront), donation for a charity or a fundraiser.",
  "The payment card is a message of its own: no buttons or selection beside it, and any words you write arrive in a message before it.",
  "When the person pays, the request moves to succeeded, you get payment.succeeded, and a payment_receipt message from the payer arrives as a reply to the card. An unpaid request expires after 23 hours (payment.expired); cancel one with POST /v1/payment_requests/{id}/cancel (payment.canceled).",
].join(" ");

/**
 * How a text-only agent sends a payment card: the same words for every bridge
 * that sends the agent's final text for it.
 */
export const PAYMENT_BLOCK_INSTRUCTION =
  "To send a payment card for a payment request you created, end your answer with a fenced code block tagged `" + PAYMENT_FENCE + "` "
  + "holding one JSON object: {\"checkout_url\": \"...\"}, the checkout_url exactly as the request returned it. "
  + "The block is removed from your words and drawn as its own payment card, sent after them.";

/** The server's limit on a `payment` part's checkout_url. */
export const PAYMENT_CHECKOUT_URL_MAX_LENGTH = 2_048;

export interface SplitPayment {
  /** The answer with the fenced block removed and the edges trimmed. */
  text: string;
  /** The payment part the block described, when there was a valid one. */
  payment?: PaymentPart;
  /** Why a block that was there could not be used. The text then keeps it. */
  error?: string;
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const FENCE = new RegExp(
  "(^|\\n)[ \\t]*```[ \\t]*" + PAYMENT_FENCE + "(?:[ \\t][^\\r\\n]*)?\\r?\\n([\\s\\S]*?)\\r?\\n[ \\t]*```[ \\t]*(?=\\r?\\n|$)",
  "gu",
);

const BUTTONS_OR_SELECTION_FENCE = /(^|\n)[ \t]*```[ \t]*(?:buttons|selection)(?:[ \t][^\r\n]*)?\r?\n/u;

/**
 * Turns a decoded value, `{checkout_url}` or the whole part, into a `payment`
 * part, or explains why it cannot. Which request the url names, and whether it
 * is still `requested`, only the server knows.
 */
export const paymentPart = (parsed: unknown): PaymentPart | string => {
  if (!record(parsed)) return "the payment block must be a JSON object";
  const extra = Object.keys(parsed).find((key) => key !== "type" && key !== "checkout_url");
  if (extra) return `payment has unknown field ${extra}`;
  if (parsed.type !== undefined && parsed.type !== "payment") return "payment part needs type payment";
  const { checkout_url } = parsed;
  if (typeof checkout_url !== "string" || !checkout_url || checkout_url.length > PAYMENT_CHECKOUT_URL_MAX_LENGTH) {
    return `payment needs the checkout_url of a payment request, at most ${PAYMENT_CHECKOUT_URL_MAX_LENGTH} characters`;
  }
  return { type: "payment", checkout_url };
};

/** Parses the body of a payment block, JSON, into a `payment` part. */
export const parsePaymentBlock = (body: string): PaymentPart | string => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return "the payment block is not valid JSON";
  }
  return paymentPart(parsed);
};

/**
 * Lifts the one ```payment block out of an agent's answer. A payment must be
 * the only part of its message, so unlike buttons it is never attached to
 * surrounding words; the words around it stay in `text` for `answerMessages`
 * to send as their own Message(s) first. More than one payment block, or a
 * payment alongside a buttons or selection block, is a conflict: the text is
 * returned untouched with `error` set, the same handling selection uses for
 * selection+buttons.
 */
export const splitPayment = (answer: string): SplitPayment => {
  const matches = [...answer.matchAll(FENCE)];
  if (!matches.length) return { text: answer };
  if (matches.length !== 1 || BUTTONS_OR_SELECTION_FENCE.test(answer)) {
    return { text: answer, error: "send one payment and nothing else in the same message" };
  }
  const match = matches[0]!;
  const parsed = parsePaymentBlock(match[2] ?? "");
  if (typeof parsed === "string") return { text: answer, error: parsed };
  const before = answer.slice(0, match.index).trimEnd();
  const after = answer.slice(match.index + match[0].length).trimStart();
  const text = [before, after].filter(Boolean).join("\n\n");
  return { text, payment: parsed };
};
