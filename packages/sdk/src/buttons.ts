import type { ButtonItem, ButtonsPart } from "./types.js";

/**
 * The fence tag a text-only agent uses to put buttons under its answer. The
 * block body is the `items` array of a `buttons` part, exactly as the API
 * takes it, so an agent that has read the contract needs nothing else:
 *
 * ```buttons
 * [{"label": "Approve"}, {"label": "Open report", "url": "https://..."}]
 * ```
 */
export const BUTTONS_FENCE = "buttons";

/**
 * When an agent should send buttons. One text, carried verbatim by every
 * runtime's tool description or prompt, so a person gets buttons under the
 * same conditions whichever agent they talk to. The rules are the ones the
 * messaging platforms give their own business agents: Apple's quick replies
 * ("avoid expecting customers to type responses that could be handled with a
 * tap", 2 to 5 options), Google's RCS suggestions ("design for the most
 * common responses"; never "mimic phone trees"), WhatsApp's reply and
 * call-to-action buttons (distinct options; one call to action). The line
 * between a url button and a link is Messenger's ("use URL buttons for tasks
 * that you want completed on your website (for example, purchases, or
 * account linking)") and Apple's ("all URLs should be sent as Rich Links";
 * product pages, support articles, self-serve resources): a task goes on a
 * button, a thing to look at goes out as a link card.
 */
export const BUTTONS_GUIDANCE = [
  "Send buttons when your message ends with a question the person can answer by picking one of 2 to 5 short options you already know: yes or no, choosing between things you named, picking a next step, or a multiple-choice question in a quiz. Each label is a complete answer, so a tap replaces typing. Put the question in text beside the buttons.",
  "Send one button when there is one thing to do next. A url button is for a task the person completes on a web page: pay, sign in, connect an account, open their booking or order, track a package. Its label names the action, not the site. A plain button confirms one step: Start, Done, Continue. Do not ask \"ready?\" when a single button does the job.",
  "A link is for something the person will look at or read: an article, a listing, a video, a place, a product page, a support article. Send it as a link on its own, so it draws as a card with the page's title and image; never paste a bare URL into your words, and send one link per message. When the page is where the person does something, send a url button; when the page is the thing you are showing them, send a link.",
  "Do not send buttons when the answer is open-ended, when your options are not the full set of likely answers, or when you are not asking anything and there is nothing to do. One question or one action per message; never a menu of things you can do, and never as decoration.",
  "If you would otherwise write \"reply 1, 2 or 3\" or list choices for the person to type, send buttons instead. If the person asks for buttons, send them.",
  "A tap comes back to you as an ordinary message whose text is the label. Labels are at most 80 characters.",
  "Buttons disappear once tapped.",
].join(" ");

/**
 * How a text-only agent puts buttons under its answer: the same words for
 * every bridge that sends the agent's final text for it.
 */
export const BUTTONS_BLOCK_INSTRUCTION =
  "To put buttons under your answer, end it with a fenced code block tagged `" + BUTTONS_FENCE + "` "
  + "holding a JSON array of 1 to 5 items, each {\"label\": \"...\"} or {\"label\": \"...\", \"url\": \"https://...\"}. "
  + "The block is removed from the text and drawn as buttons.";

/** The server's limits (Discord's button limits): items 1..5, label 1..80, url <= 2048. */
export const BUTTONS_MAX_ITEMS = 5;
export const BUTTON_LABEL_MAX_LENGTH = 80;
export const BUTTON_URL_MAX_LENGTH = 2_048;

export interface SplitButtons {
  /** The answer with the fenced block removed and the edges trimmed. */
  text: string;
  /** The buttons part the block described, when there was a valid one. */
  buttons?: ButtonsPart;
  /** Why a block that was there could not be used. The text then keeps it. */
  error?: string;
}

const FENCE = new RegExp(
  "(^|\\n)[ \\t]*```[ \\t]*" + BUTTONS_FENCE + "[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n[ \\t]*```[ \\t]*(?=\\r?\\n|$)",
  "u",
);

const asItem = (value: unknown, index: number): ButtonItem | string => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return `item ${index + 1} is not an object`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter((key) => key !== "label" && key !== "url");
  if (keys.length > 0) return `item ${index + 1} has unknown field ${keys[0]}`;
  const { label, url } = record;
  if (typeof label !== "string" || label.length === 0) return `item ${index + 1} needs a label`;
  if (label.length > BUTTON_LABEL_MAX_LENGTH) {
    return `item ${index + 1} label is over ${BUTTON_LABEL_MAX_LENGTH} characters`;
  }
  if (url === undefined) return { label };
  if (typeof url !== "string" || url.length > BUTTON_URL_MAX_LENGTH) {
    return `item ${index + 1} url is not a string of at most ${BUTTON_URL_MAX_LENGTH} characters`;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error();
  } catch {
    return `item ${index + 1} url is not an http(s) URL`;
  }
  return { url, label };
};

/**
 * Turns a decoded value, an array of items or a whole part, into a `buttons`
 * part, or explains why it cannot. The checks are the server's own, so a bad
 * value fails here with a readable reason instead of a 400 from the API.
 */
export const buttonsPart = (parsed: unknown): ButtonsPart | string => {
  const wrapped = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as { items?: unknown }
    : undefined;
  const items = Array.isArray(parsed) ? parsed : Array.isArray(wrapped?.items) ? wrapped.items : undefined;
  if (items === undefined) return "the buttons block must be a JSON array of items";
  if (items.length === 0) return "the buttons block has no items";
  if (items.length > BUTTONS_MAX_ITEMS) {
    return `the buttons block has ${items.length} items; the most is ${BUTTONS_MAX_ITEMS}`;
  }
  const result: ButtonItem[] = [];
  for (const [index, value] of items.entries()) {
    const item = asItem(value, index);
    if (typeof item === "string") return item;
    result.push(item);
  }
  return { type: "buttons", items: result };
};

/** Parses the body of a buttons block, JSON, into a `buttons` part. */
export const parseButtonsBlock = (body: string): ButtonsPart | string => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return "the buttons block is not valid JSON";
  }
  return buttonsPart(parsed);
};

/**
 * Lifts the first ```buttons block out of an agent's answer. The text around
 * it becomes the text part; the block becomes the buttons part. When the
 * block is malformed, the answer is returned untouched with `error` set, so
 * the person still gets the words and the operator sees why.
 */
export const splitButtons = (answer: string): SplitButtons => {
  const match = FENCE.exec(answer);
  if (!match) return { text: answer };
  const parsed = parseButtonsBlock(match[2] ?? "");
  if (typeof parsed === "string") return { text: answer, error: parsed };
  const start = match.index + (match[1]?.length ?? 0);
  const before = answer.slice(0, start).replace(/\s+$/u, "");
  const after = answer.slice(match.index + match[0].length).replace(/^\s+/u, "");
  const text = before && after ? `${before}\n\n${after}` : before || after;
  return { text, buttons: parsed };
};

/**
 * The parts a text answer with optional buttons becomes: the text first, when
 * there is any, then the buttons. A buttons-only message is one the server
 * accepts, so an answer that is nothing but the block sends just the buttons.
 */
export const partsWithButtons = (
  text: string,
  buttons: ButtonsPart | undefined,
  limit = Number.POSITIVE_INFINITY,
): Array<{ type: "text"; value: string } | ButtonsPart> => [
  ...(text.length > 0 ? [{ type: "text" as const, value: text.slice(0, limit) }] : []),
  ...(buttons ? [buttons] : []),
];
