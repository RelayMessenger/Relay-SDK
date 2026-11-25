import type Relay from "@relaymessenger/sdk";
import type { ModelMessage, ToolSet, UIMessage } from "ai";

import {
  withInboundMedia,
  withRecentHistoryImages,
  type InboundMedia,
} from "../attachments.js";
import type { PersonMemory } from "../memory.js";

export interface PrepareTurnMessagesInput {
  /** Model messages assembled by Think before media or memory augmentation. */
  messages: readonly ModelMessage[];
  /** Inbound media downloaded for the current turn (optional). */
  media?: InboundMedia;
  /** Stored UIMessage history aligned with `messages`, for recent image recall (optional). */
  history?: readonly UIMessage[];
  /** Relay client used with `history` to refresh attachment URLs (optional). */
  relay?: Pick<Relay, "attachments">;
  /** Per-person memory handle (optional). */
  memory?: Pick<PersonMemory, "turn">;
  /** Abort signal for the active turn (optional). */
  signal?: AbortSignal;
}

export interface PreparedTurnMessages {
  messages: ModelMessage[];
  tools?: ToolSet;
}

/**
 * Prepare turn messages for the model:
 * - attaches inbound media and recent history images onto the model messages;
 * - passes the unmodified user messages to `memory.turn` so converted document
 *   text and attachment notices never pollute the FTS memory query;
 * - splices any recalled person-memory message immediately before the newest
 *   turn message, preserving both media parts and history images.
 */
export async function prepareTurnMessages(
  input: PrepareTurnMessagesInput,
): Promise<PreparedTurnMessages> {
  const raw = [...input.messages];
  const withMedia = input.media ? withInboundMedia(raw, input.media) : raw;

  const [withImages, remembered] = await Promise.all([
    input.history && input.relay
      ? withRecentHistoryImages(withMedia, input.history, input.relay, input.signal)
      : Promise.resolve(withMedia),
    input.memory ? input.memory.turn(raw, input.signal) : Promise.resolve(undefined),
  ]);

  if (!remembered) {
    return { messages: withImages };
  }

  let messages = withImages;
  if (remembered.messages.length > raw.length) {
    const inserted = raw.length > 0
      ? remembered.messages.slice(raw.length - 1, remembered.messages.length - 1)
      : remembered.messages;
    messages = withImages.length > 0
      ? [...withImages.slice(0, -1), ...inserted, withImages[withImages.length - 1]!]
      : inserted;
  }

  return {
    messages,
    tools: remembered.tools,
  };
}
