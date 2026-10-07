import { createHash } from "node:crypto";
import { SELECTION_CONTEXT_MAX_LENGTH, componentParts, formReply, locationContext, indexedIdempotencyKey, partsWithButtons, partsWithForm, partsWithSelection, selectionReply, type FormPart, type SelectionPart, type ButtonsPart, type PaymentPart } from "@relaymessenger/sdk";
import type {
  Chat,
  Message,
  MessagePart,
  RatingRequestPart,
  MessagePartResponse,
  MessageSendParams,
  RelayWebhookEvent,
} from "@relaymessenger/sdk";
import { senderIsAllowed, type AllowedSenders } from "./config.ts";
import type { Redactor } from "./redaction.ts";
import type { DeliveryCandidate } from "./types.ts";

const MAX_RELAY_TEXT = 10_000;

/**
 * A contact card shared into the chat (`system_event` of type
 * `contact_card_shared`), as untrusted JSON: who shared it and the card.
 */
function contactCardMeta(systemEvent: unknown, redactor: Redactor): Record<string, string> {
  if (!isRecord(systemEvent) || systemEvent.type !== "contact_card_shared" || !isRecord(systemEvent.contact_card)) return {};
  const actor = isRecord(systemEvent.actor) && typeof systemEvent.actor.handle === "string" ? systemEvent.actor.handle : null;
  const card = JSON.stringify({ shared_by: actor, card: systemEvent.contact_card });
  return {
    contact_card: redactor.text(card.length > SELECTION_CONTEXT_MAX_LENGTH
      ? `${card.slice(0, SELECTION_CONTEXT_MAX_LENGTH)}… [truncated]` : card),
  };
}

function selectionMeta(parts: readonly MessagePartResponse[], replyTo: Message["reply_to"], redactor: Redactor, systemEvent?: unknown): Record<string, string> {
  const selection = selectionReply(parts, replyTo);
  const form = formReply(parts, replyTo);
  // Words, links and media are already in `content`; only the parts the
  // channel cannot show as text ride along, and never past the text cap.
  const components = componentParts(parts);
  const rich = components.length ? JSON.stringify(components) : "";
  return {
    ...contactCardMeta(systemEvent, redactor),
    ...(rich ? {
      relay_parts: redactor.text(rich.length > SELECTION_CONTEXT_MAX_LENGTH
        ? `${rich.slice(0, SELECTION_CONTEXT_MAX_LENGTH)}… [truncated]` : rich),
      ...(replyTo ? { reply_to: JSON.stringify(replyTo) } : {}),
    } : {}),
    ...(selection ? {
      selection_response: redactor.text(JSON.stringify({ selected_values: selection.selected_values })),
      reply_to: JSON.stringify(selection.reply_to),
    } : {}),
    ...(form ? {
      form_response: redactor.text(JSON.stringify({ answers: form.answers })),
      reply_to: JSON.stringify(form.reply_to),
    } : {}),
  };
}

/** See `DeliveryCandidate.linksReply`. */
function linksReply(senderKind: string, parts: readonly MessagePartResponse[]): boolean {
  const opening = parts[0]?.type;
  return senderKind === "agent" && opening !== "buttons" && opening !== "selection" && opening !== "form";
}

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
  // A pin and a location share have no words; their data follows the words.
  const content = [
    parts
      .map(renderPart)
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .join("\n"),
    locationContext(parts),
  ].filter(Boolean).join("\n\n");
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
  if (data.is_from_me === true) {
    return { kind: "ignore", reason: "message.received is this agent's own Message" };
  }
  // `from_handle` matches the REST Message object; `sender_handle` is the
  // deprecated field that servers before 2026-10-04 send instead.
  const senderField = data.from_handle ?? data.sender_handle;
  const sender = isRecord(senderField) ? senderField : null;
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
      ...selectionMeta(parts, data.reply_to, params.redactor, data.system_event),
      chat_id: chatId,
      message_id: messageId,
      sender_id: senderId,
      sender_handle: params.redactor.text(senderHandle),
      delivery_id: event.event_id,
      source_sequence: params.sequence,
      sent_at: typeof data.sent_at === "string" ? data.sent_at : event.created_at,
    },
    ...(linksReply(senderKind, parts) ? { linksReply: true } : {}),
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
  if (!sender || (sender.kind !== "user" && sender.kind !== "agent")) {
    if (snapshotMessageIsUnreadByAgent(message)) {
      throw new Error(
        `FULL sync cannot authenticate unread inbound Message ${message.id}: from_handle is absent or has an unsupported kind`,
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
      ...selectionMeta(parts, message.reply_to, params.redactor),
      chat_id: message.chat_id,
      message_id: message.id,
      sender_id: sender.id,
      sender_handle: params.redactor.text(sender.handle),
      delivery_id: deliveryId,
      source_sequence: params.throughSequence,
      sent_at: message.sent_at ?? message.created_at,
      full_sync: "true",
    },
    ...(linksReply(sender.kind, parts) ? { linksReply: true } : {}),
    createdAt: message.created_at,
  };
}

export function buildReply(
  text: string,
  idempotencyKey: string,
  replyTo?: string,
  buttons?: ButtonsPart,
  selection?: SelectionPart,
  form?: FormPart,
  attached: readonly MessagePart[] = [],
): MessageSendParams {
  if (selection && buttons) throw new Error("selection and buttons do not go together");
  if (form && (buttons || selection)) throw new Error("a form sits beside text only");
  if (attached.length > 0 && (selection || form)) throw new Error("media, a place or a card do not go with a selection or form");
  if (text.length > MAX_RELAY_TEXT || (!text && !buttons && !selection && !form && attached.length === 0)) {
    throw new Error(`text must be 1-${MAX_RELAY_TEXT} UTF-16 code units`);
  }
  // Media, a place and a card sit after the words and above any buttons.
  const words = partsWithButtons(text, undefined);
  return {
    message: {
      parts: form ? partsWithForm(text, form) : selection ? partsWithSelection(text, selection)
        : [...words, ...attached, ...(buttons ? [buttons] : [])],
      idempotency_key: idempotencyKey,
      ...(replyTo ? { reply_to: { message_id: replyTo } } : {}),
    },
  };
}

/**
 * The Messages one reply becomes: the words (with any buttons) first, then
 * the link as its own Message, which the server requires and the app draws
 * as a card, then any payment, which must also be the only part of its
 * Message. A reply that is only a link or only a payment is one Message.
 * Each Message past the first carries its index in the key.
 */
export function buildReplyMessages(
  text: string,
  idempotencyKey: string,
  replyTo?: string,
  buttons?: ButtonsPart,
  link?: string,
  selection?: SelectionPart,
  payment?: PaymentPart,
  form?: FormPart,
  ratingRequest?: RatingRequestPart,
  attached: readonly MessagePart[] = [],
): MessageSendParams[] {
  if (ratingRequest) {
    if (text || buttons || link || selection || payment || form || attached.length > 0) throw new Error("a rating request is the whole Message");
    return [{ message: { parts: [ratingRequest], idempotency_key: idempotencyKey,
      ...(replyTo ? { reply_to: { message_id: replyTo } } : {}) } }];
  }
  if (selection && (buttons || link)) throw new Error("selection cannot be combined with buttons or link");
  if (payment && (buttons || selection)) throw new Error("a payment cannot be combined with buttons or selection");
  if (form && (buttons || link || selection || payment)) throw new Error("a form sits beside text only");
  if (!link && !payment) return [buildReply(text, idempotencyKey, replyTo, buttons, selection, form, attached)];
  const messages: MessageSendParams[] = [];
  if (text || buttons || attached.length > 0) messages.push(buildReply(text, idempotencyKey, replyTo, buttons, undefined, undefined, attached));
  const solo = (part: MessagePart): void => {
    messages.push({
      message: {
        parts: [part],
        idempotency_key: indexedIdempotencyKey(idempotencyKey, messages.length),
        ...(messages.length === 0 && replyTo ? { reply_to: { message_id: replyTo } } : {}),
      },
    });
  };
  if (link) solo({ type: "link", value: link });
  if (payment) solo(payment);
  return messages;
}

export function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
