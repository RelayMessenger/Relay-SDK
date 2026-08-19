import { DEFAULT_EMOJI_MAP } from "chat";
import type { EmojiValue } from "chat";
import type { RelayReactionType } from "./types.js";

/**
 * Relay renders six reactions as iMessage-style tapback balloons and anything
 * else as a plain emoji. The six are named on the wire, so a thumbs up must be
 * sent as `like` rather than as the character, or it lands as a generic emoji
 * reaction instead of the balloon a Relay user expects.
 */
const TAPBACKS: Record<string, RelayReactionType> = {
  heart: "love",
  thumbs_up: "like",
  thumbs_down: "dislike",
  laugh: "laugh",
  exclamation: "emphasize",
  question: "question",
};

const PLACEHOLDER = /^\{\{emoji:([^}]+)\}\}$/;
const SHORTCODE = /^:([a-z0-9_+-]+):$/i;
/** Variation selector 16 and the five skin tone modifiers. */
const DECORATION = /[️\u{1F3FB}-\u{1F3FF}]/gu;

function firstFormat(value: string | string[]): string {
  return Array.isArray(value) ? (value[0] as string) : value;
}

function bare(value: string): string {
  return value.replace(DECORATION, "");
}

let literalIndex: Map<string, string> | undefined;

/** Lazily invert the emoji map so a literal character resolves to its name. */
function nameForLiteral(literal: string): string | undefined {
  if (!literalIndex) {
    literalIndex = new Map();
    for (const [name, formats] of Object.entries(DEFAULT_EMOJI_MAP)) {
      const unicode = Array.isArray(formats.gchat) ? formats.gchat : [formats.gchat];
      for (const candidate of unicode) {
        const key = bare(candidate);
        if (!literalIndex.has(key)) literalIndex.set(key, name);
      }
    }
  }
  return literalIndex.get(bare(literal));
}

let slackIndex: Map<string, string> | undefined;

function nameForAlias(alias: string): string | undefined {
  if (!slackIndex) {
    slackIndex = new Map();
    for (const [name, formats] of Object.entries(DEFAULT_EMOJI_MAP)) {
      const aliases = Array.isArray(formats.slack) ? formats.slack : [formats.slack];
      for (const candidate of aliases) {
        if (!slackIndex.has(candidate)) slackIndex.set(candidate, name);
      }
    }
  }
  return slackIndex.get(alias);
}

function isEmojiValue(value: EmojiValue | string): value is EmojiValue {
  return typeof value === "object" && value !== null && "name" in value;
}

export interface RelayReaction {
  type: RelayReactionType;
  emoji?: string;
}

/**
 * Resolve a Chat SDK reaction into Relay's `{ type, emoji }` pair. Accepts an
 * `EmojiValue`, a `:shortcode:`, a bare well-known name, the `{{emoji:name}}`
 * placeholder an `EmojiValue` stringifies to, or a literal character.
 */
export function toRelayReaction(input: EmojiValue | string): RelayReaction {
  let name: string | undefined;
  let literal: string | undefined;

  if (isEmojiValue(input)) {
    name = input.name;
  } else {
    const trimmed = input.trim();
    const placeholder = PLACEHOLDER.exec(trimmed);
    const shortcode = SHORTCODE.exec(trimmed);
    const candidate = placeholder?.[1] ?? shortcode?.[1] ?? trimmed;
    if (candidate in DEFAULT_EMOJI_MAP) {
      name = candidate;
    } else if (nameForAlias(candidate)) {
      name = nameForAlias(candidate);
    } else if (placeholder || shortcode) {
      throw new Error(`unknown emoji name for a Relay reaction: ${trimmed}`);
    } else {
      literal = trimmed;
      name = nameForLiteral(trimmed);
    }
  }

  if (name && name in TAPBACKS) {
    return { type: TAPBACKS[name] as RelayReactionType };
  }
  if (literal) return { type: "emoji", emoji: literal };
  if (name) {
    const formats = DEFAULT_EMOJI_MAP[name];
    if (formats) return { type: "emoji", emoji: firstFormat(formats.gchat) };
  }
  throw new Error(
    "a Relay reaction needs an emoji character or a well-known emoji name",
  );
}
