import type { InvoiceGoods, InvoicePart, InvoiceRecurring } from "./types.js";

/**
 * The fence tag a text-only agent uses to ask someone to pay. The block body
 * is one JSON object, the `invoice` part exactly as the API takes it:
 *
 * ```invoice
 * {"title": "House blend, 250 g", "amount": 2400, "currency": "usd", "goods": "physical", "url": "https://buy.stripe.com/test_123"}
 * ```
 */
export const INVOICE_FENCE = "invoice";

/**
 * When an agent should send an invoice. One text, carried verbatim by every
 * runtime's tool description or prompt. References: Linq Agent Pay ("a card
 * is the whole message"); Telegram `sendInvoice` (only the bot sends
 * invoices); Apple 3.1.3(e)/3.1.1(a) (physical goods or services used outside
 * the app may use any non-IAP method; digital goods may only be linked out).
 */
export const INVOICE_GUIDANCE = [
  "Send an invoice only when the person asked to buy something or has already agreed to a price; never invoice out of the blue.",
  "url must be a real checkout link you were given — your own Stripe Payment Link, Stripe Checkout, Shopify page, or anything https. Never invent one, and never paste a checkout link in text or a button; send an invoice instead.",
  "Set goods honestly: physical for goods or services used outside the app, digital for anything delivered in chat or used inside an app.",
  "An invoice must be the only part of its message: no words, no buttons, no selection beside it.",
  "Use recurring for a subscription: interval day, week, month or year, for up to 3 years total.",
  "When your own system learns the payment went through, for example your Stripe webhook, mark it with the status route so the card updates for the person.",
].join(" ");

/**
 * How a text-only agent asks someone to pay: the same words for every bridge
 * that sends the agent's final text for it.
 */
export const INVOICE_BLOCK_INSTRUCTION =
  "To ask the person to pay, end your answer with nothing else and a fenced code block tagged `" + INVOICE_FENCE + "` "
  + "holding one JSON object: {\"title\": \"...\", \"amount\": 2400, \"currency\": \"usd\", "
  + "\"goods\": \"physical\" or \"digital\", \"url\": \"https://...\"}, with an optional "
  + "\"recurring\": {\"interval\": \"month\", \"interval_count\": 1} for a subscription. "
  + "The block is removed from the text and drawn as an invoice card; it must be alone in its message.";

/** The server's limits (Telegram title, Stripe amount/url/recurring span). */
export const INVOICE_TITLE_MAX_LENGTH = 32;
export const INVOICE_MAX_AMOUNT = 99_999_999;
export const INVOICE_URL_MAX_LENGTH = 2_048;
/** Total recurring span capped at 3 years: 1095 days / 156 weeks / 36 months / 3 years. */
export const INVOICE_RECURRING_MAX_COUNT: Record<InvoiceRecurring["interval"], number> = {
  day: 1_095,
  week: 156,
  month: 36,
  year: 3,
};

export interface SplitInvoice {
  /** The answer with the fenced block removed and the edges trimmed. */
  text: string;
  /** The invoice part the block described, when there was a valid one. */
  invoice?: InvoicePart;
  /** Why a block that was there could not be used. The text then keeps it. */
  error?: string;
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const FENCE = new RegExp(
  "(^|\\n)[ \\t]*```[ \\t]*" + INVOICE_FENCE + "(?:[ \\t][^\\r\\n]*)?\\r?\\n([\\s\\S]*?)\\r?\\n[ \\t]*```[ \\t]*(?=\\r?\\n|$)",
  "gu",
);

const BUTTONS_OR_SELECTION_FENCE = /(^|\n)[ \t]*```[ \t]*(?:buttons|selection)(?:[ \t][^\r\n]*)?\r?\n/u;

/**
 * Turns a decoded value, the fields object or the whole part, into an
 * `invoice` part, or explains why it cannot. The checks are the server's own,
 * so a bad value fails here with a readable reason instead of a 400 from the
 * API. `currency` is normalized to lowercase.
 */
export const invoicePart = (parsed: unknown): InvoicePart | string => {
  if (!record(parsed)) return "the invoice block must be a JSON object";
  const allowed = new Set(["type", "title", "amount", "currency", "goods", "url", "recurring"]);
  const extra = Object.keys(parsed).find((key) => !allowed.has(key));
  if (extra) return `invoice has unknown field ${extra}`;
  if (parsed.type !== undefined && parsed.type !== "invoice") return "invoice part needs type invoice";
  const { title, amount, currency, goods, url, recurring } = parsed;
  if (typeof title !== "string" || !title.trim() || title.trim().length > INVOICE_TITLE_MAX_LENGTH) {
    return `invoice needs a trimmed title of 1 to ${INVOICE_TITLE_MAX_LENGTH} characters`;
  }
  if (!Number.isInteger(amount) || (amount as number) < 1 || (amount as number) > INVOICE_MAX_AMOUNT) {
    return `invoice amount must be an integer of 1 to ${INVOICE_MAX_AMOUNT}`;
  }
  if (typeof currency !== "string" || !/^[A-Za-z]{3}$/u.test(currency)) {
    return "invoice currency must be a 3-letter code";
  }
  if (goods !== "physical" && goods !== "digital") {
    return 'invoice goods must be "physical" or "digital"';
  }
  if (typeof url !== "string" || url.length > INVOICE_URL_MAX_LENGTH) {
    return `invoice url is not a string of at most ${INVOICE_URL_MAX_LENGTH} characters`;
  }
  try {
    if (new URL(url).protocol !== "https:") throw new Error();
  } catch {
    return "invoice url is not an https URL";
  }
  let normalizedRecurring: InvoiceRecurring | undefined;
  if (recurring !== undefined) {
    if (!record(recurring)) return "invoice recurring must be an object";
    const recurringExtra = Object.keys(recurring)
      .find((key) => key !== "interval" && key !== "interval_count");
    if (recurringExtra) return `invoice recurring has unknown field ${recurringExtra}`;
    const { interval, interval_count } = recurring;
    if (typeof interval !== "string" || !(interval in INVOICE_RECURRING_MAX_COUNT)) {
      return "invoice recurring interval must be day, week, month or year";
    }
    const max = INVOICE_RECURRING_MAX_COUNT[interval as InvoiceRecurring["interval"]];
    const count = interval_count === undefined ? 1 : interval_count;
    if (!Number.isInteger(count) || (count as number) < 1 || (count as number) > max) {
      return `invoice recurring interval_count for ${interval} must be an integer of 1 to ${max}`;
    }
    normalizedRecurring = { interval: interval as InvoiceRecurring["interval"], interval_count: count as number };
  }
  return {
    type: "invoice",
    title: title.trim(),
    amount: amount as number,
    currency: currency.toLowerCase(),
    goods: goods as InvoiceGoods,
    url,
    ...(normalizedRecurring ? { recurring: normalizedRecurring } : {}),
  };
};

/** Parses the body of an invoice block, JSON, into an `invoice` part. */
export const parseInvoiceBlock = (body: string): InvoicePart | string => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return "the invoice block is not valid JSON";
  }
  return invoicePart(parsed);
};

/**
 * Lifts the one ```invoice block out of an agent's answer. An invoice must be
 * the only part of its message, so unlike buttons it is never attached to
 * surrounding words; the words around it stay in `text` for `answerMessages`
 * to send as their own Message(s) first. More than one invoice block, or an
 * invoice alongside a buttons or selection block, is a conflict: the text is
 * returned untouched with `error` set, the same handling selection uses for
 * selection+buttons.
 */
export const splitInvoice = (answer: string): SplitInvoice => {
  const matches = [...answer.matchAll(FENCE)];
  if (!matches.length) return { text: answer };
  if (matches.length !== 1 || BUTTONS_OR_SELECTION_FENCE.test(answer)) {
    return { text: answer, error: "send one invoice and nothing else in the same message" };
  }
  const match = matches[0]!;
  const parsed = parseInvoiceBlock(match[2] ?? "");
  if (typeof parsed === "string") return { text: answer, error: parsed };
  const before = answer.slice(0, match.index).trimEnd();
  const after = answer.slice(match.index + match[0].length).trimStart();
  const text = [before, after].filter(Boolean).join("\n\n");
  return { text, invoice: parsed };
};
