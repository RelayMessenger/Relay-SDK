import type { Relay } from "./client.js";
import type { PaymentCategory, PaymentPart, PaymentRequestCreateParams, RequestOptions } from "./types.js";

/**
 * The fence tag a text-only agent uses to ask someone to pay. The block body
 * is one JSON object, the payment request's fields as `POST
 * /v1/payment_requests` takes them; the bridge creates the request with its
 * own token and sends the card:
 *
 * ```payment
 * {"description": "House blend, 250 g", "category": "physical_goods", "amount": 2400, "currency": "usd"}
 * ```
 */
export const PAYMENT_FENCE = "payment";

/**
 * How an agent asks someone to pay, for every runtime whose bridge creates the
 * payment request for the model (the model never holds the Relay token). Only
 * what the model cannot know: the fields, where the card goes, and the three
 * categories, one line each, from the contract's `PaymentCategory`.
 */
export const PAYMENT_GUIDANCE = [
  "A payment asks the person to pay through your Stripe account, drawn as a card in its own message after your words, never beside buttons or a selection.",
  "Give description (the card's title, 1 to 32 characters), category, and amount in minor units (2400 is 24.00) with a 3-letter currency; for a subscription, give mode subscription and a price_id from your Stripe account, with an optional quantity, instead of amount and currency. image_url, an https picture of the product, is optional.",
  "category physical_goods: physical things and real-world services.",
  "category digital_goods: digital content and tips.",
  "category donation: a charity or a fundraiser.",
  "When the person pays, a payment_receipt message from them arrives.",
].join(" ");

/**
 * How a text-only agent asks someone to pay: the same words for every bridge
 * that sends the agent's final text for it.
 */
export const PAYMENT_BLOCK_INSTRUCTION =
  "To ask the person to pay, end your answer with a fenced code block tagged `" + PAYMENT_FENCE + "` "
  + "holding one JSON object: {\"description\": \"...\", \"category\": \"physical_goods\", \"amount\": 2400, \"currency\": \"usd\"}. "
  + "The block is removed from your words; Relay creates the payment and sends its card after them.";

/** The server's limits on the fields a model supplies. */
export const PAYMENT_DESCRIPTION_MAX_LENGTH = 32;
export const PAYMENT_IMAGE_URL_MAX_LENGTH = 2_048;
export const PAYMENT_CATEGORIES = ["physical_goods", "digital_goods", "donation"] as const satisfies readonly PaymentCategory[];

export interface SplitPayment {
  /** The answer with the fenced block removed and the edges trimmed. */
  text: string;
  /** The payment request the block described, when there was a valid one. */
  payment?: PaymentRequestCreateParams;
  /** Why a block that was there could not be used. The text then keeps it. */
  error?: string;
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const MODEL_FIELDS = new Set(["description", "category", "amount", "currency", "mode", "price_id", "quantity", "image_url"]);

/**
 * Turns the fields a model supplied into `POST /v1/payment_requests`'s body,
 * or explains why it cannot. Only the fields a model can know are accepted;
 * `metadata`, `customer_id` and `discount` belong to the developer's own
 * code. Stripe's own checks (minimum amount, an unknown price) stay with the
 * server, which returns them as a 400 carrying Stripe's message.
 */
export const paymentRequestFields = (parsed: unknown): PaymentRequestCreateParams | string => {
  if (!record(parsed)) return "the payment block must be a JSON object";
  const extra = Object.keys(parsed).find((key) => !MODEL_FIELDS.has(key));
  if (extra) return `payment has unknown field ${extra}`;
  const { description, category, amount, currency, mode, price_id, quantity, image_url } = parsed;
  if (typeof description !== "string" || !description.trim()
    || [...description.trim()].length > PAYMENT_DESCRIPTION_MAX_LENGTH) {
    return `payment needs a description of 1 to ${PAYMENT_DESCRIPTION_MAX_LENGTH} characters`;
  }
  if (!(PAYMENT_CATEGORIES as readonly unknown[]).includes(category)) {
    return `payment category must be ${PAYMENT_CATEGORIES.join(", ")}`;
  }
  if (mode !== undefined && mode !== "payment" && mode !== "subscription") {
    return "payment mode must be payment or subscription";
  }
  if (image_url !== undefined && (typeof image_url !== "string" || !image_url.startsWith("https://")
    || image_url.length > PAYMENT_IMAGE_URL_MAX_LENGTH)) {
    return `payment image_url must be an https address of at most ${PAYMENT_IMAGE_URL_MAX_LENGTH} characters`;
  }
  const fields: PaymentRequestCreateParams = {
    description: description.trim(),
    category: category as PaymentCategory,
    ...(image_url !== undefined ? { image_url: image_url as string } : {}),
  };
  if (mode === "subscription") {
    if (amount !== undefined || currency !== undefined) {
      return "a subscription takes its amount and currency from price_id; omit amount and currency";
    }
    if (typeof price_id !== "string" || !price_id) return "a subscription needs a price_id";
    if (quantity !== undefined && (!Number.isInteger(quantity) || (quantity as number) < 1)) {
      return "payment quantity must be a whole number of at least 1";
    }
    return {
      ...fields, mode: "subscription", price_id,
      ...(quantity !== undefined ? { quantity: quantity as number } : {}),
    };
  }
  if (price_id !== undefined || quantity !== undefined) {
    return "price_id and quantity are for mode subscription";
  }
  if (!Number.isInteger(amount) || (amount as number) < 1) {
    return "payment amount must be a whole number of minor units, at least 1";
  }
  if (typeof currency !== "string" || !/^[A-Za-z]{3}$/u.test(currency)) {
    return "payment currency must be a 3-letter code";
  }
  return { ...fields, amount: amount as number, currency: currency.toLowerCase() };
};

/** Parses the body of a payment block, JSON, into a payment request's fields. */
export const parsePaymentBlock = (body: string): PaymentRequestCreateParams | string => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return "the payment block is not valid JSON";
  }
  return paymentRequestFields(parsed);
};

const FENCE = new RegExp(
  "(^|\\n)[ \\t]*```[ \\t]*" + PAYMENT_FENCE + "(?:[ \\t][^\\r\\n]*)?\\r?\\n([\\s\\S]*?)\\r?\\n[ \\t]*```[ \\t]*(?=\\r?\\n|$)",
  "gu",
);

const BUTTONS_OR_SELECTION_FENCE = /(^|\n)[ \t]*```[ \t]*(?:buttons|selection)(?:[ \t][^\r\n]*)?\r?\n/u;

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

/**
 * Creates the payment request a model described and returns the `payment`
 * part that carries it. `idempotencyKey` is the card Message's own key, so a
 * retry of the same answer returns the same request (the server scopes the
 * key to this agent's payment requests). A refusal (403 until Stripe is
 * connected, 400 with Stripe's message) is thrown as the API error for the
 * bridge to hand back.
 */
export const createPaymentPart = async (
  client: Pick<Relay, "paymentRequests">,
  fields: PaymentRequestCreateParams,
  idempotencyKey: string,
  options?: RequestOptions,
): Promise<PaymentPart> => {
  const request = await client.paymentRequests.create(fields, { ...options, idempotencyKey });
  return { type: "payment", checkout_url: request.checkout_url };
};
