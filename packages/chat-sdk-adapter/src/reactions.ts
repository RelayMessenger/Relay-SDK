import { ValidationError } from "@chat-adapter/shared";
import {
  defaultEmojiResolver,
  getEmoji,
  type EmojiValue,
} from "chat";
import type { RelayReactionType } from "./types.js";

export interface RelayReactionInput {
  customEmoji?: string;
  type: RelayReactionType;
}

const STANDARD_BY_NAME: Record<string, RelayReactionType> = {
  exclamation: "emphasize",
  heart: "love",
  laugh: "laugh",
  question: "question",
  thumbs_down: "dislike",
  thumbs_up: "like",
};

const NAME_BY_STANDARD: Record<
  Exclude<RelayReactionType, "custom">,
  string
> = {
  dislike: "thumbs_down",
  emphasize: "exclamation",
  laugh: "laugh",
  like: "thumbs_up",
  love: "heart",
  question: "question",
};

function normalizeName(input: string): string {
  const placeholder = /^\{\{emoji:([^}]+)\}\}$/.exec(input.trim());
  const shortcode = /^:([^:]+):$/.exec(input.trim());
  return (placeholder?.[1] ?? shortcode?.[1] ?? input.trim()).toLowerCase();
}

function looksLikeUnicodeEmoji(value: string): boolean {
  return (
    /\p{Extended_Pictographic}/u.test(value) ||
    /\p{Regional_Indicator}{2}/u.test(value)
  );
}

export function toRelayReaction(
  input: EmojiValue | string,
): RelayReactionInput {
  const raw = typeof input === "string" ? input.trim() : input.name;
  const normalized = normalizeName(raw);
  const standard = STANDARD_BY_NAME[normalized];
  if (standard) return { type: standard };

  const literal = looksLikeUnicodeEmoji(raw)
    ? raw
    : defaultEmojiResolver.toGChat(normalized);
  if (!looksLikeUnicodeEmoji(literal)) {
    throw new ValidationError(
      "relay",
      `Relay custom reactions require a Unicode emoji; received ${JSON.stringify(
        raw,
      )}`,
    );
  }
  return { customEmoji: literal, type: "custom" };
}

export function fromRelayReaction(input: {
  customEmoji?: string | null;
  type: RelayReactionType;
}): { emoji: EmojiValue; rawEmoji: string } {
  if (input.type === "custom") {
    if (!input.customEmoji) {
      throw new ValidationError(
        "relay",
        "A custom Relay reaction event is missing custom_emoji",
      );
    }
    return {
      emoji: defaultEmojiResolver.fromGChat(input.customEmoji),
      rawEmoji: input.customEmoji,
    };
  }
  const name = NAME_BY_STANDARD[input.type];
  return {
    emoji: getEmoji(name),
    rawEmoji: defaultEmojiResolver.toGChat(name),
  };
}
