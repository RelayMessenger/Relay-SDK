import { createHash } from "node:crypto";
import type {
  Chat,
  Message,
  MessagePartResponse,
  MessageSendParams,
  RelayWebhookEvent,
} from "@relaymessenger/sdk";
import { senderIsAllowed, type AllowedSenders } from "./config.ts";
import type { Redactor } from "./redaction.ts";
import type { DeliveryCandidate } from "./types.ts";

const MAX_RELAY_TEXT = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function renderPart(part: MessagePartResponse): string | null {
  if (part.type === "text") return part.value;
  if (part.type === "link") return part.value;
  if (part.type === "media") {
    const details = [part.filename, part.mime_type, `${part.size_bytes} bytes`]
      .filter(Boolean)
      .join(", ");
    return `[Relay attachment: ${details}]\n${part.url}`;
  }
  if (part.type === "system") return part.value;
  return null;
}

export function messageContent(parts: readonly MessagePartResponse[], redactor: Redactor): string {
  const content = parts
    .map(renderPart)
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join("\n");
  const redacted = redactor.text(content || "(Relay message with no supported text)");
  if (redacted.length <= MAX_RELAY_TEXT) return redacted;
  return `${redacted.slice(0, MAX_RELAY_TEXT - 1)}…`;
}

export type InboundAction =
  | { readonly kind: "ignore"; readonly reason: string }
  | { readonly kind: "refuse"; readonly reason: string }
  | { readonly kind: "blocked"; readonly senderId: string; readonly senderHandle: string }
  | {
      readonly kind: "delivery";
      readonly delivery: DeliveryCandidate;
      readonly groupGate: "direct" | "mention" | "reply" | "unaddressed";
      readonly replyToMessageId: string | null;
    };

function normalizedHandle(value: string): string {
  return value.replace(/^@/u, "").toLowerCase();
}

export function partsMentionHandle(
  parts: readonly MessagePartResponse[],
  handle: string | null,
): boolean {
  if (!handle) return false;
  const wanted = normalizedHandle(handle);
  return parts.some((part) =>
    part.type === "text"
    && typeof part.mention === "string"
    && normalizedHandle(part.mention) === wanted);
}

function snapshotOwnerHandle(chat: Chat): string | null {
  const owners = chat.handles.filter((handle) =>
    handle.kind === "agent" && handle.is_me === true);
  return owners.length === 1 ? owners[0]?.handle ?? null : null;
}

function snapshotMessageIsUnreadByAgent(message: Message): boolean {
  const ownDeliveries = (message.deliveries ?? []).filter((delivery) =>
    delivery.contact.is_me === true);
  if (ownDeliveries.length !== 1) {
    throw new Error(
      `FULL sync cannot determine this Agent's Read state for Message ${message.id}: expected one deliveries[].contact.is_me row`,
    );
  }
  const own = ownDeliveries[0];
  if (
    !own
    || own.contact.kind !== "agent"
    || (own.read_at !== null && typeof own.read_at !== "string")
  ) {
    throw new Error(
      `FULL sync received an invalid deliveries[].contact.is_me row for Message ${message.id}`,
    );
  }
  return own.read_at === null;
}

export function classifyRelayEvent(params: {
  readonly event: RelayWebhookEvent;
  readonly sequence: string;
  readonly allowedSenders: AllowedSenders;
  readonly redactor: Redactor;
}): InboundAction {
  const { event } = params;
  if (event.event_type !== "message.received") {
    return { kind: "ignore", reason: `event type ${event.event_type} is not an inbound Message` };
  }
  if (!isRecord(event.data)) return { kind: "refuse", reason: "Message event data is not an object" };
  const data = event.data;
  const chat = isRecord(data.chat) ? data.chat : null;
  const sender = isRecord(data.sender_handle) ? data.sender_handle : null;
  const chatId = typeof chat?.id === "string" ? chat.id : "";
  const messageId = typeof data.id === "string" ? data.id : "";
  const senderId = typeof sender?.id === "string" ? sender.id : "";
  const senderHandle = typeof sender?.handle === "string" ? sender.handle : "";
  const senderKind = typeof sender?.kind === "string" ? sender.kind : "";
  const parts = data.parts as MessagePartResponse[];
  const direction = data.direction;
  if (!chatId || !messageId || !senderId || !senderHandle || !Array.isArray(data.parts)) {
    return { kind: "refuse", reason: "Message event is missing current Relay v1 fields" };
  }
  if (direction !== "inbound") {
    return { kind: "refuse", reason: "message.received direction is not inbound" };
  }
  if (!senderIsAllowed(params.allowedSenders, {
    id: senderId,
    handle: senderHandle,
    kind: senderKind,
  })) {
    return { kind: "blocked", senderId, senderHandle };
  }
  const isGroup = chat?.is_group === true;
  const owner = isRecord(chat?.owner_handle) ? chat.owner_handle : null;
  const ownerHandle = (
    owner?.kind === "agent"
    && owner.id === event.agent_id
    && typeof owner.handle === "string"
  )
    ? owner.handle
    : null;
  const replyTo = isRecord(data.reply_to) && typeof data.reply_to.message_id === "string"
    ? data.reply_to.message_id
    : null;
  const groupGate = !isGroup
    ? "direct"
    : partsMentionHandle(parts, ownerHandle)
      ? "mention"
      : replyTo
        ? "reply"
        : "unaddressed";
  const content = messageContent(parts, params.redactor);
  const delivery: DeliveryCandidate = {
    deliveryId: event.event_id,
    eventId: event.event_id,
    messageId,
    chatId,
    senderId,
    senderHandle,
    content,
    meta: {
      chat_id: chatId,
      message_id: messageId,
      sender_id: senderId,
      sender_handle: params.redactor.text(senderHandle),
      delivery_id: event.event_id,
      source_sequence: params.sequence,
      sent_at: typeof data.sent_at === "string" ? data.sent_at : event.created_at,
    },
    createdAt: event.created_at,
  };
  return {
    kind: "delivery",
    delivery,
    groupGate,
    replyToMessageId: replyTo,
  };
}

export function deliveryFromSnapshotMessage(params: {
  readonly message: Message;
  readonly chat: Chat;
  readonly agentMessageIds: ReadonlySet<string>;
  readonly throughSequence: string;
  readonly allowedSenders: AllowedSenders;
  readonly redactor: Redactor;
}): DeliveryCandidate | null {
  const message = params.message;
  if (message.is_from_me || message.is_system_message) return null;
  const sender = message.from_handle;
  if (!sender || sender.kind !== "user") {
    if (snapshotMessageIsUnreadByAgent(message)) {
      throw new Error(
        `FULL sync cannot authenticate unread inbound Message ${message.id}: from_handle is absent`,
      );
    }
    return null;
  }
  if (!senderIsAllowed(params.allowedSenders, sender)) return null;
  const parts = message.parts ?? [];
  if (params.chat.is_group) {
    const mentioned = partsMentionHandle(parts, snapshotOwnerHandle(params.chat));
    const replyToAgent = typeof message.reply_to?.message_id === "string"
      && params.agentMessageIds.has(message.reply_to.message_id);
    if (!mentioned && !replyToAgent) return null;
  }
  if (!snapshotMessageIsUnreadByAgent(message)) return null;
  const deliveryId = `fullsync-${message.id}`;
  return {
    deliveryId,
    eventId: null,
    messageId: message.id,
    chatId: message.chat_id,
    senderId: sender.id,
    senderHandle: sender.handle,
    content: messageContent(parts, params.redactor),
    meta: {
      chat_id: message.chat_id,
      message_id: message.id,
      sender_id: sender.id,
      sender_handle: params.redactor.text(sender.handle),
      delivery_id: deliveryId,
      source_sequence: params.throughSequence,
      sent_at: message.sent_at ?? message.created_at,
      full_sync: "true",
    },
    createdAt: message.created_at,
  };
}

export function buildReply(text: string, idempotencyKey: string, replyTo?: string): MessageSendParams {
  if (!text || text.length > MAX_RELAY_TEXT) {
    throw new Error(`text must be 1-${MAX_RELAY_TEXT} UTF-16 code units`);
  }
  return {
    message: {
      parts: [{ type: "text", value: text }],
      idempotency_key: idempotencyKey,
      ...(replyTo ? { reply_to: { message_id: replyTo } } : {}),
    },
  };
}

export function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
