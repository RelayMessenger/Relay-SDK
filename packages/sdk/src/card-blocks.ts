import { CAROUSEL_MAX_CARDS, CAROUSEL_MIN_CARDS, RICH_CARD_MAX_SUGGESTIONS } from "./rich-cards.js";
import type { CarouselPart, PlacePart, RichCardPart } from "./types.js";

/**
 * How a text-only agent sends a card, a carousel or a place: a fenced block,
 * as it sends buttons, a selection or a form. Relay checks every field when
 * the Message is sent; this reads only the shape, so a block that is not a
 * card stays in the words instead of failing the send.
 */
export const CARD_BLOCK_INSTRUCTION =
  "To send a card, end your answer with a fenced code block tagged `rich_card` containing "
  + '{"title":"Lagoon House","description":"Two nights, sea view","media":{"type":"image","url":"https://..."},'
  + '"suggestions":[{"type":"reply","label":"Book","id":"book_lagoon"},{"type":"open_url","label":"Details","url":"https://..."}]}. '
  + "For 2 to 10 cards the person swipes sideways, use a block tagged `carousel` containing "
  + '{"cards":[{"title":"..."},{"title":"..."}]}. Words outside the block are sent as a normal message above the card.';

export const CARD_GUIDANCE =
  "A card has at least one of media (an https image or video), title (1 to 200 characters) or description (1 to 2000), "
  + "and up to 4 suggestions, each with a label of 1 to 25 characters. A reply suggestion needs an id (1 to 256 characters, "
  + "unique in the Message, across all cards of a carousel); a tap comes back as the person's text (the label) with "
  + "suggestion_response.id, so dispatch on the id, never the label. open_url, dial (phone_number in E.164), view_location "
  + "(latitude and longitude, or query), share_location and create_calendar_event (start_time, end_time, title) act on the "
  + "person's phone and send nothing back. Send one card or one carousel per answer, never with a selection, form or payment; "
  + "buttons may sit under a card.";

export const PLACE_BLOCK_INSTRUCTION =
  "To send a place on a map, add a fenced code block tagged `place` containing "
  + '{"latitude":37.4422,"longitude":-122.1615,"name":"Philz Coffee","address":"101 Forest Ave, Palo Alto"}; '
  + "name and address are optional, 1 to 256 characters each. The place is sent as its own Message after your words.";

const FENCE = /(^|\n)[ \t]*```[ \t]*(rich_card|carousel|place)(?:[ \t][^\r\n]*)?\r?\n([\s\S]*?)\r?\n[ \t]*```[ \t]*(?=\r?\n|$)/gu;
const EXCLUSIVE = /(^|\n)[ \t]*```[ \t]*(?:selection|form|payment|rating_request)(?:[ \t][^\r\n]*)?\r?\n/u;

export interface SplitCardBlocks {
  /** The answer without the lifted blocks. */
  text: string;
  card?: RichCardPart | CarouselPart;
  place?: PlacePart;
  /** Why the blocks could not be used. The text then keeps them. */
  error?: string;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const cardError = (card: unknown): string | undefined => {
  if (!isObject(card)) return "a card needs a JSON object";
  if (card.media === undefined && card.title === undefined && card.description === undefined) {
    return "a card needs media, a title or a description";
  }
  if (card.suggestions !== undefined
    && (!Array.isArray(card.suggestions) || card.suggestions.length > RICH_CARD_MAX_SUGGESTIONS)) {
    return `a card's suggestions are a list of at most ${RICH_CARD_MAX_SUGGESTIONS}`;
  }
  return undefined;
};

const parse = (tag: string, body: string): RichCardPart | CarouselPart | PlacePart | string => {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return `the ${tag} block is not JSON`;
  }
  if (!isObject(value)) return `the ${tag} block needs a JSON object`;
  const { type: _type, ...fields } = value;
  if (tag === "place") {
    const { latitude, longitude } = fields;
    if (typeof latitude !== "number" || typeof longitude !== "number"
      || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
      return "a place needs latitude (-90 to 90) and longitude (-180 to 180) as numbers";
    }
    return { type: "place", ...fields } as PlacePart;
  }
  if (tag === "carousel") {
    const cards = fields.cards;
    if (!Array.isArray(cards) || cards.length < CAROUSEL_MIN_CARDS || cards.length > CAROUSEL_MAX_CARDS) {
      return `a carousel needs ${CAROUSEL_MIN_CARDS} to ${CAROUSEL_MAX_CARDS} cards`;
    }
    const error = cards.map(cardError).find(Boolean);
    return error ?? ({ type: "carousel", ...fields } as unknown as CarouselPart);
  }
  return cardError(fields) ?? ({ type: "rich_card", ...fields } as RichCardPart);
};

/**
 * Lifts at most one `rich_card` or `carousel` block and at most one `place`
 * block out of an answer. A card beside a selection, form, payment or rating
 * request block, or a block that is not one, leaves the answer as it was,
 * with an error.
 */
export const splitCardBlocks = (answer: string): SplitCardBlocks => {
  const matches = [...answer.matchAll(FENCE)];
  if (!matches.length) return { text: answer };
  const cards = matches.filter((match) => match[2] !== "place");
  if (cards.length > 1 || matches.length - cards.length > 1) {
    return { text: answer, error: "send at most one card or carousel and at most one place per answer" };
  }
  if (cards.length && EXCLUSIVE.test(answer)) {
    return { text: answer, error: "a card cannot be sent with a selection, form, payment or rating request" };
  }
  const result: SplitCardBlocks = { text: answer };
  let text = answer;
  for (const match of [...matches].reverse()) {
    const part = parse(match[2]!, match[3] ?? "");
    if (typeof part === "string") return { text: answer, error: part };
    if (part.type === "place") result.place = part;
    else result.card = part;
    const start = match.index + match[1]!.length;
    text = [text.slice(0, start).trimEnd(), text.slice(match.index + match[0].length).trimStart()].filter(Boolean).join("\n\n");
  }
  result.text = text;
  return result;
};
