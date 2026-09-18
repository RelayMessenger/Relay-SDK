import type { MediaPartResponse, MessagePartResponse, RelayWebhookEvent } from "@relaymessenger/sdk";

/** One message this process answers. */
export interface BridgeTurn {
  eventId: string;
  chatId: string;
  sender: string;
  text: string;
  media: MediaPartResponse[];
}

/** An inbound message with text or media in it. */
export const bridgeTurn = (event: RelayWebhookEvent): BridgeTurn | undefined => {
  if (event.event_type !== "message.received") return undefined;
  const data = event.data as {
    chat?: { id?: unknown } | null;
    direction?: unknown;
    sender_handle?: { handle?: unknown } | null;
    parts?: unknown;
  };
  if (data.direction !== "inbound") return undefined;
  const chatId = typeof data.chat?.id === "string" ? data.chat.id : "";
  const sender = typeof data.sender_handle?.handle === "string" ? data.sender_handle.handle : "";
  const parts = Array.isArray(data.parts) ? data.parts as MessagePartResponse[] : [];
  const media = parts.filter((part): part is MediaPartResponse => part.type === "media");
  const text = parts
    .flatMap((part) => part.type === "text" || part.type === "link"
      ? [part.value]
      : part.type === "button_reply" ? [part.label] : [])
    .join("\n")
    .trim();
  if (!chatId || !sender || (!text && media.length === 0)) return undefined;
  return { eventId: event.event_id, chatId, sender, text, media };
};

