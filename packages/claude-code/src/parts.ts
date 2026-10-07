import {
  CAROUSEL_MAX_CARDS,
  CAROUSEL_MIN_CARDS,
  RICH_CARD_DESCRIPTION_MAX_LENGTH,
  RICH_CARD_MAX_SUGGESTIONS,
  RICH_CARD_TITLE_MAX_LENGTH,
  SUGGESTION_LABEL_MAX_LENGTH,
} from "@relaymessenger/sdk";
import type { CardContent, CarouselPart, PlacePart, RichCardPart, RichCardSuggestion } from "@relaymessenger/sdk";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedText(value: unknown, max: number): boolean {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

/** A place the agent names (Relay `PlacePart`); a string is the reason it is refused. */
export function placePart(value: unknown): PlacePart | string {
  if (!isRecord(value)) return "must be an object with latitude and longitude";
  const { latitude, longitude, name, address, ...rest } = value;
  if (Object.keys(rest).length > 0) return `unknown field ${Object.keys(rest)[0]}`;
  if (typeof latitude !== "number" || !Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    return "latitude must be a number from -90 to 90";
  }
  if (typeof longitude !== "number" || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    return "longitude must be a number from -180 to 180";
  }
  if (name !== undefined && !boundedText(name, 256)) return "name must be 1 to 256 characters";
  if (address !== undefined && !boundedText(address, 256)) return "address must be 1 to 256 characters";
  return {
    type: "place",
    latitude,
    longitude,
    ...(name !== undefined ? { name: name as string } : {}),
    ...(address !== undefined ? { address: address as string } : {}),
  };
}

/**
 * One card's content. The shape is Relay's `CardContent`; the server checks
 * the finer rules (unique reply ids, URL schemes, event times) and its 400
 * names what to fix.
 */
function cardContent(value: unknown): CardContent | string {
  if (!isRecord(value)) return "each card must be an object";
  const { media, title, description, suggestions, ...rest } = value;
  if (Object.keys(rest).length > 0) return `unknown card field ${Object.keys(rest)[0]}`;
  if (media === undefined && title === undefined && description === undefined) {
    return "a card needs media, a title or a description";
  }
  if (title !== undefined && !boundedText(title, RICH_CARD_TITLE_MAX_LENGTH)) {
    return `title must be 1 to ${RICH_CARD_TITLE_MAX_LENGTH} characters`;
  }
  if (description !== undefined && !boundedText(description, RICH_CARD_DESCRIPTION_MAX_LENGTH)) {
    return `description must be 1 to ${RICH_CARD_DESCRIPTION_MAX_LENGTH} characters`;
  }
  if (media !== undefined) {
    if (!isRecord(media) || (media.type !== "image" && media.type !== "video") || typeof media.url !== "string") {
      return "media must be { type: image or video, url }";
    }
  }
  if (suggestions !== undefined) {
    if (!Array.isArray(suggestions) || suggestions.length === 0 || suggestions.length > RICH_CARD_MAX_SUGGESTIONS) {
      return `suggestions must be 1 to ${RICH_CARD_MAX_SUGGESTIONS} items`;
    }
    for (const suggestion of suggestions) {
      if (!isRecord(suggestion) || typeof suggestion.type !== "string") return "each suggestion needs a type";
      if (!boundedText(suggestion.label, SUGGESTION_LABEL_MAX_LENGTH)) {
        return `each suggestion label must be 1 to ${SUGGESTION_LABEL_MAX_LENGTH} characters`;
      }
    }
  }
  return {
    ...(media !== undefined ? { media: media as unknown as NonNullable<CardContent["media"]> } : {}),
    ...(title !== undefined ? { title: title as string } : {}),
    ...(description !== undefined ? { description: description as string } : {}),
    ...(suggestions !== undefined ? { suggestions: suggestions as RichCardSuggestion[] } : {}),
  };
}

export function richCardPart(value: unknown): RichCardPart | string {
  const card = cardContent(value);
  return typeof card === "string" ? card : { type: "rich_card", ...card };
}

export function carouselPart(value: unknown): CarouselPart | string {
  if (!isRecord(value)) return "must be an object with cards";
  const { cards, card_width: cardWidth, ...rest } = value;
  if (Object.keys(rest).length > 0) return `unknown field ${Object.keys(rest)[0]}`;
  if (!Array.isArray(cards) || cards.length < CAROUSEL_MIN_CARDS || cards.length > CAROUSEL_MAX_CARDS) {
    return `cards must be ${CAROUSEL_MIN_CARDS} to ${CAROUSEL_MAX_CARDS} cards`;
  }
  if (cardWidth !== undefined && cardWidth !== "small" && cardWidth !== "medium") return "card_width must be small or medium";
  const parsed: CardContent[] = [];
  for (const card of cards) {
    const content = cardContent(card);
    if (typeof content === "string") return content;
    parsed.push(content);
  }
  return { type: "carousel", ...(cardWidth !== undefined ? { card_width: cardWidth } : {}), cards: parsed };
}
