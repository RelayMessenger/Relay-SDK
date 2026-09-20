import { selectionReply, type SelectionReply, type ReplyTo, type MediaPartResponse, type MessagePartResponse, type RelayWebhookEvent } from "@relaymessenger/sdk";

/** One message this process answers. */
export interface BridgeTurn {
  eventId: string;
  chatId: string;
  sender: string;
  text: string;
  media: MediaPartResponse[];
  selection?: SelectionReply;
}

/** An inbound message with text or media in it. */
export const bridgeTurn = (event: RelayWebhookEvent): BridgeTurn | undefined => {
  if (event.event_type !== "message.received") return undefined;
  const data = event.data as {
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
  if (!chatId || !sender || (!text && media.length === 0)) return undefined;
  const selection = selectionReply(parts, data.reply_to);
  return { eventId: event.event_id, chatId, sender, text, media, ...(selection ? { selection } : {}) };
};

