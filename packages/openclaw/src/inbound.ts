import type {
  MessagePartResponse,
  RelayWebhookEvent,
} from "@relaymessenger/sdk";
import type {
  RelayInboundFacts,
  RelayMessageReceivedEvent,
} from "./types.js";

function renderPart(part: MessagePartResponse): string | undefined {
  switch (part.type) {
    case "text":
      return part.value;
    case "link":
      return part.value;
    case "media":
      return `[Attachment: ${part.filename} (${part.mime_type})] ${part.url}`;
    case "system":
      return part.value;
  }
}

export function renderRelayMessageParts(
  parts: readonly MessagePartResponse[],
): string {
  return parts
    .map(renderPart)
    .filter((value): value is string => Boolean(value?.trim()))
    .join("\n");
}

export function isRelayMessageReceivedEvent(
  event: RelayWebhookEvent,
): event is RelayMessageReceivedEvent {
  if (event.event_type !== "message.received") return false;
  const data = event.data as Partial<RelayMessageReceivedEvent["data"]>;
  return (
    typeof data.id === "string" &&
    typeof data.chat?.id === "string" &&
    data.direction === "inbound" &&
    typeof data.sender_handle?.id === "string" &&
    Array.isArray(data.parts)
  );
}

/**
 * Map the current Relay v1 Message event to OpenClaw facts. Agent-authored
 * Messages are accepted at the transport boundary but do not start turns.
 */
export function buildRelayInboundFacts(
  event: RelayWebhookEvent,
): RelayInboundFacts | null {
  if (!isRelayMessageReceivedEvent(event)) return null;
  if (event.data.sender_handle.kind !== "user") return null;

  const text = renderRelayMessageParts(event.data.parts);
  if (!text.trim()) return null;

  const mentionHandles = event.data.parts.flatMap((part) =>
    part.type === "text" &&
    typeof part.mention === "string" &&
    part.mention.length > 0
      ? [part.mention]
      : [],
  );
  const timestampValue = event.data.sent_at ?? event.created_at;
  const timestamp = Date.parse(timestampValue);
  return {
    eventId: event.event_id,
    messageId: event.data.id,
    chatId: event.data.chat.id,
    chatType: event.data.chat.is_group === true ? "group" : "direct",
    contactId: event.data.sender_handle.id,
    handle: event.data.sender_handle.handle,
    displayName:
      event.data.sender_handle.display_name?.trim() ||
      event.data.sender_handle.handle,
    text,
    mentionHandles,
    ...(event.data.chat.owner_handle
      ? { ownerHandle: event.data.chat.owner_handle }
      : {}),
    ...(event.data.reply_to?.message_id
      ? { replyToId: event.data.reply_to.message_id }
      : {}),
    ...(Number.isFinite(timestamp) ? { timestamp } : {}),
  };
}
