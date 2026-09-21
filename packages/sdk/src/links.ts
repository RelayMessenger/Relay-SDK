import { splitButtons } from "./buttons.js";
import { splitSelection } from "./selection.js";
import type { ButtonsPart, LinkPart, MessagePart, TextPart } from "./types.js";

/**
 * How a text-only agent sends a link: the URL alone on its own line, the way
 * a person pastes one into Messages and the way Linq's iMessage guide asks for
 * it ("put a single URL on its own line"). The line leaves the words and goes
 * out as a `link` part in its own Message, which the server requires and the
 * app draws as a card. The same words for every bridge that sends the agent's
 * final text for it.
 */
export const LINK_LINE_INSTRUCTION =
  "To send a link, put its URL alone on its own line. That line leaves your text and is sent as its own Message, in order with your words, and drawn as a card with the page's title and image.";

/** The server's limit for a link part's URL (contracts/relay-v1-openapi.yaml). */
export const LINK_URL_MAX_LENGTH = 2_048;

/** Relay takes 1 to 255 characters for an idempotency key. */
export const IDEMPOTENCY_KEY_MAX_LENGTH = 255;

/**
 * The URL a line carries when the line is nothing but one absolute HTTP or
 * HTTPS URL; otherwise undefined. A URL inside a sentence stays words.
 */
export const standaloneLink = (line: string): string | undefined => {
  const value = line.trim();
  if (!/^https?:\/\/\S+$/iu.test(value) || value.length > LINK_URL_MAX_LENGTH) return undefined;
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) return undefined;
  } catch {
    return undefined;
  }
  return value;
};

export type AnswerSegment = TextPart | LinkPart;

/**
 * Splits an answer into its words and the links written alone on a line, in
 * order. Text on either side of a link keeps its own line breaks, trimmed at
 * the edges; an answer with no such line comes back as one text segment,
 * untouched.
 */
export const splitLinks = (text: string): AnswerSegment[] => {
  const segments: AnswerSegment[] = [];
  let words: string[] = [];
  const flush = (): void => {
    const value = words.join("\n").trim();
    if (value) segments.push({ type: "text", value });
    words = [];
  };
  for (const line of text.split(/\r?\n/u)) {
    const link = standaloneLink(line);
    if (link === undefined) {
      words.push(line);
      continue;
    }
    flush();
    segments.push({ type: "link", value: link });
  }
  if (!segments.some((segment) => segment.type === "link")) {
    return text.length > 0 ? [{ type: "text", value: text }] : [];
  }
  flush();
  return segments;
};

export interface AnswerMessages {
  /** The Messages the answer becomes, in order; each is one parts array. */
  messages: MessagePart[][];
  /** Why a component block could not be used. The text then keeps it. */
  error?: string;
}

/**
 * The Messages a text-only agent's answer becomes: a buttons or selection
 * block is lifted out, then each link on its own line becomes its own Message.
 * The component accompanies the last Message of words. Selection requires a
 * nonblank question; conflicting components remain text with an error.
 */
export const answerMessages = (answer: string): AnswerMessages => {
  const selected = splitSelection(answer);
  if (selected.error) {
    // The block stays in the words, but a link still travels alone; a bad
    // component must not also take the person's link cards away.
    return { messages: splitLinks(answer).map((segment) => [segment]), error: selected.error };
  }
  if (selected.selection) {
    const messages: MessagePart[][] = splitLinks(selected.text).map((segment) => [segment]);
    const prompt = messages.findLast((parts) => parts[0]?.type === "text" && parts[0].value.trim());
    if (!prompt) {
      return { messages: [[{ type: "text", value: answer }]], error: "selection needs a nonblank text prompt" };
    }
    prompt.push(selected.selection);
    return { messages };
  }
  const { text, buttons, error } = splitButtons(answer);
  const messages: MessagePart[][] = splitLinks(text).map((segment) => [segment]);
  if (buttons) attachButtons(messages, buttons);
  return error ? { messages, error } : { messages };
};

const attachButtons = (messages: MessagePart[][], buttons: ButtonsPart): void => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.[0]?.type === "text") {
      messages[index]!.push(buttons);
      return;
    }
  }
  messages.push([buttons]);
};

/**
 * The idempotency key for the `index`th Message of one answer: the answer's
 * own key for the first, and that key with the index for the rest, kept
 * within Relay's 255 characters.
 */
export const indexedIdempotencyKey = (key: string, index: number): string => {
  if (index === 0) return key;
  const suffix = `-${index}`;
  return `${key.slice(0, IDEMPOTENCY_KEY_MAX_LENGTH - suffix.length)}${suffix}`;
};
