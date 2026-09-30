import type { MessagePartResponse, ReplyTo } from "./types.js";

/** Rich card and carousel limits, the server's (Relay-Server `rich-cards.ts`). */
export const RICH_CARD_TITLE_MAX_LENGTH = 200;
export const RICH_CARD_DESCRIPTION_MAX_LENGTH = 2_000;
export const RICH_CARD_MAX_SUGGESTIONS = 4;
export const SUGGESTION_LABEL_MAX_LENGTH = 25;
export const SUGGESTION_ID_MAX_LENGTH = 256;
export const CAROUSEL_MIN_CARDS = 2;
export const CAROUSEL_MAX_CARDS = 10;

/** The reply suggestion a person tapped: its id, its label, and the card part it answers. */
export interface SuggestionReply {
  id: string;
  label: string;
  reply_to: ReplyTo & { part_index: number };
}

/**
 * Read a card reply from a received Message's parts and reply_to. Dispatch on
 * `id`, never on the visible label.
 */
export const suggestionReply = (
  parts: readonly MessagePartResponse[],
  replyTo?: ReplyTo | null,
): SuggestionReply | undefined => {
  const response = parts.find((part) => part.type === "suggestion_response");
  if (!response || !replyTo?.message_id || !Number.isInteger(replyTo.part_index)
    || replyTo.part_index! < 0) return undefined;
  return {
    id: response.id,
    label: response.label,
    reply_to: { message_id: replyTo.message_id, part_index: replyTo.part_index! },
  };
};
