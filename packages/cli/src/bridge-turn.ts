import { selectionReply, selectionReplyContext, type SelectionReply, type ReplyTo, type MediaPartResponse, type MessagePartResponse, type RelayWebhookEvent } from "@relaymessenger/sdk";

/** One message this process answers. */
export interface BridgeTurn {
  eventId: string;
  chatId: string;
  sender: string;
  text: string;
  media: MediaPartResponse[];
  selection?: SelectionReply;
  richMessage?: { parts: MessagePartResponse[]; reply_to?: ReplyTo | null };
  /**
   * Whether another agent sent it. An agent's messages wait their turn; a
   * person's newer message replaces the answer still being written.
   */
  fromAgent: boolean;
  /**
   * The message the answer replies to: this one, when another agent sent it.
   * Relay's A2A door gives a calling agent the reply that names its message
   * (Relay-Server `a2a.ts` `replyTo`), as a bot's reply names the message it
   * answers (Telegram `reply_to_message_id`, Discord `message_reference`).
   * A person's message is not named, so the chat looks as it always has.
   * Absent when the message opens with buttons or a selection: an agent may
   * not reply to those parts, and a reply names part 0 unless it says
   * otherwise.
   */
  replyTo?: ReplyTo;
}

/**
 * Whether a newer message in a chat replaces the answer still being written
 * for an older one. A person's newer message replaces a person's answer, as
 * before. An agent's message waits its turn instead, and an answer to an
 * agent is never dropped: the calling agent is waiting for it, and each
 * message it sent gets its own answer (A2A 1.0, 3.1.1).
 */
export const replacesLiveTurn = (
  newer: Pick<BridgeTurn, "fromAgent">,
  live: Pick<BridgeTurn, "fromAgent">,
): boolean => !newer.fromAgent && !live.fromAgent;

/** An inbound message with text or media in it. */
export const bridgeTurn = (event: RelayWebhookEvent): BridgeTurn | undefined => {
  if (event.event_type !== "message.received") return undefined;
  const data = event.data as {
    id?: unknown;
    chat?: { id?: unknown } | null;
    direction?: unknown;
    sender_handle?: { handle?: unknown; kind?: unknown } | null;
    parts?: unknown;
    reply_to?: ReplyTo | null;
  };
  if (data.direction !== "inbound") return undefined;
  const chatId = typeof data.chat?.id === "string" ? data.chat.id : "";
  const sender = typeof data.sender_handle?.handle === "string" ? data.sender_handle.handle : "";
  const parts = Array.isArray(data.parts) ? data.parts as MessagePartResponse[] : [];
  const media = parts.filter((part): part is MediaPartResponse => part.type === "media");
  const text = parts
    .flatMap((part) => part.type === "text" || part.type === "link" ? [part.value] : [])
    .join("\n")
    .trim();
  const selection = selectionReply(parts, data.reply_to);
  const message = { parts, ...(data.reply_to ? { reply_to: data.reply_to } : {}) };
  const richMessage = selectionReplyContext(undefined, message) ? message : undefined;
  if (!chatId || !sender || (!text && media.length === 0 && !richMessage)) return undefined;
  const fromAgent = data.sender_handle?.kind === "agent";
  const opening = parts[0]?.type;
  const replyTo = fromAgent && typeof data.id === "string" && data.id
    && opening !== "buttons" && opening !== "selection"
    ? { message_id: data.id }
    : undefined;
  return { eventId: event.event_id, chatId, sender, text, media, fromAgent,
    ...(selection ? { selection } : {}), ...(richMessage ? { richMessage } : {}),
    ...(replyTo ? { replyTo } : {}) };
};

