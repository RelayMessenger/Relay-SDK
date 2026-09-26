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
   * The message the answer replies to: this one. Relay's A2A door gives a
   * caller the reply that names its message (Relay-Server `a2a.ts`
   * `replyTo`), as a bot's reply names the message it answers
   * (Telegram `reply_to_message_id`, Discord `message_reference`). Absent
   * when the message opens with buttons or a selection: an agent may not
   * reply to those parts, and a reply names part 0 unless it says otherwise.
   */
  replyTo?: ReplyTo;
}

/** An inbound message with text or media in it. */
export const bridgeTurn = (event: RelayWebhookEvent): BridgeTurn | undefined => {
  if (event.event_type !== "message.received") return undefined;
  const data = event.data as {
    id?: unknown;
    chat?: { id?: unknown } | null;
    direction?: unknown;
    sender_handle?: { handle?: unknown } | null;
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
  const opening = parts[0]?.type;
  const replyTo = typeof data.id === "string" && data.id && opening !== "buttons" && opening !== "selection"
    ? { message_id: data.id }
    : undefined;
  return { eventId: event.event_id, chatId, sender, text, media,
    ...(selection ? { selection } : {}), ...(richMessage ? { richMessage } : {}),
    ...(replyTo ? { replyTo } : {}) };
};

