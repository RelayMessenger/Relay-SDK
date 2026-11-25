import {
  verifyWebhookSignature,
  WebhookVerificationError,
  type RelayAdapter,
} from "@relaymessenger/chat-sdk-adapter";

import { PAYMENT_CHAT_METADATA_KEY } from "../payment.js";

const MAX_RELAY_WEBHOOK_BYTES = 8 * 1_048_576;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export const RELAY_MESSAGE_ADMISSION_HEADER = "x-relay-message-admission";
export const RELAY_MESSAGE_SERIAL_HEADER = "x-relay-message-serial";

export interface RelayMessageAdmission {
  messageId: string;
  sentAt: number;
  /** Sent by an agent: it never cancels a reply already being written. */
  fromAgent?: true;
}

export function formatRelayMessageIdentity(
  admission: RelayMessageAdmission,
): string {
  return admission.fromAgent
    ? `${admission.sentAt}:${admission.messageId}:agent`
    : `${admission.sentAt}:${admission.messageId}`;
}

/** Exact verified delivery persisted by the chat object before returning 2xx. */
export interface RelayWebhookDelivery {
  admission?: RelayMessageAdmission;
  body: string;
  eventId: string;
  eventType: string;
  headers: Record<string, string>;
  instanceName: string;
  serial?: RelayMessageAdmission;
  url: string;
}

export interface AuthenticatedRelayWebhook {
  admission?: RelayMessageAdmission;
  delivery?: RelayWebhookDelivery;
  serial?: RelayMessageAdmission;
  request(): Request;
  instanceName: string;
  /**
   * Identity of the delivery, when the envelope parsed.
   *
   * The Worker acknowledges a parseable delivery itself, so it needs the two
   * fields Relay expects echoed back. An unparseable envelope leaves this
   * undefined and the Agent answers with its canonical invalid_json instead.
   */
  event?: { id: string; type: string };
}

export interface MentionPart {
  type: string;
  mention?: string | null;
  mentions?: ReadonlyArray<{ handle?: string; is_me?: boolean }> | null;
}

interface RelayMessageIngress extends RelayMessageAdmission {
  actionable: boolean;
}

function durableWebhookHeaders(headers: Headers): Record<string, string> {
  const durable: Record<string, string> = {};
  for (const name of [
    "content-type",
    "webhook-id",
    "webhook-timestamp",
    "webhook-signature",
  ]) {
    const value = headers.get(name);
    if (value !== null) durable[name] = value;
  }
  return durable;
}

function jsonError(status: number, code: string): Response {
  return Response.json({ error: { code } }, { status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Handles tagged in a single message part, reading both `part.mentions`
 * (multi-mention array) and legacy `part.mention` (single string).
 */
export function extractPartMentions(
  part: unknown,
  ownHandle?: string,
): string[] {
  if (!isRecord(part) || part.type !== "text") return [];
  const found: string[] = [];
  if (typeof part.mention === "string" && part.mention.length > 0) {
    found.push(part.mention);
  }
  if (Array.isArray(part.mentions)) {
    for (const entry of part.mentions) {
      if (!isRecord(entry)) continue;
      if (typeof entry.handle === "string" && entry.handle.length > 0) {
        found.push(entry.handle);
      } else if (entry.is_me === true && ownHandle) {
        found.push(ownHandle);
      }
    }
  }
  return found;
}

/**
 * Deduplicated handles tagged across all text parts of a message, supporting
 * both `part.mentions` and legacy `part.mention`.
 */
export function mentionedHandles(
  parts: ReadonlyArray<unknown>,
  ownHandle?: string,
): Set<string> {
  const handles = new Set<string>();
  for (const part of parts) {
    for (const handle of extractPartMentions(part, ownHandle)) {
      handles.add(handle);
    }
  }
  return handles;
}

/** Whether `ownerHandle` is mentioned in any text part (via `mentions` or `mention`). */
export function isOwnerMentioned(
  parts: ReadonlyArray<unknown>,
  ownerHandle: string | undefined,
): boolean {
  if (!ownerHandle) return false;
  return mentionedHandles(parts, ownerHandle).has(ownerHandle);
}

function relayMessageIngress(
  envelope: Record<string, unknown>,
  everyGroupMessage: boolean,
): RelayMessageIngress | undefined {
  if (
    envelope.api_version !== "v1"
    || envelope.webhook_version !== "2026-08-30"
    || envelope.event_type !== "message.received"
    || typeof envelope.event_id !== "string"
    || !UUID.test(envelope.event_id)
    || typeof envelope.agent_id !== "string"
    || !UUID.test(envelope.agent_id)
    || typeof envelope.trace_id !== "string"
    || envelope.trace_id.length === 0
    || typeof envelope.created_at !== "string"
    || !Number.isFinite(Date.parse(envelope.created_at))
  ) {
    return;
  }
  const data = envelope.data;
  if (!isRecord(data) || data.direction !== "inbound") return;
  const messageId = data.id;
  const chat = data.chat;
  const sender = isRecord(data.from_handle) ? data.from_handle : data.sender_handle;
  const chatId = typeof data.chat_id === "string"
    ? data.chat_id
    : isRecord(chat) && typeof chat.id === "string"
      ? chat.id
      : undefined;
  if (
    typeof messageId !== "string"
    || !UUID.test(messageId)
    || typeof chatId !== "string"
    || !UUID.test(chatId)
    || !isRecord(sender)
    || typeof sender.id !== "string"
    || !UUID.test(sender.id)
    || typeof sender.handle !== "string"
    || (sender.kind !== "user" && sender.kind !== "agent")
    || data.is_from_me === true
    || sender.is_me === true
    || !Array.isArray(data.parts)
  ) {
    return;
  }
  let actionable = true;
  if (isRecord(chat) && chat.is_group === true && !everyGroupMessage) {
    const owner = chat.owner_handle;
    const ownerHandle = isRecord(owner) && typeof owner.handle === "string"
      ? owner.handle
      : undefined;
    actionable = isOwnerMentioned(data.parts, ownerHandle);
  }
  const sentAt = typeof data.sent_at === "string"
      && Number.isFinite(Date.parse(data.sent_at))
    ? Date.parse(data.sent_at)
    : Date.parse(envelope.created_at);
  return {
    actionable,
    messageId,
    sentAt,
    ...(sender.kind === "agent" ? { fromAgent: true as const } : {}),
  };
}

async function readExactBody(request: Request): Promise<Uint8Array | Response> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RELAY_WEBHOOK_BYTES) {
        await reader.cancel();
        return jsonError(413, "payload_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Authenticate the exact public request body before resolving a Durable
 * Object. Keeps unsigned or oversized requests away from private Agent RPCs.
 */
export async function authenticateRelayWebhook(
  request: Request,
  secret: string,
  /** Admit every group Message; the speak gate and model may stay silent. */
  { everyGroupMessage = false }: { everyGroupMessage?: boolean } = {},
): Promise<AuthenticatedRelayWebhook | Response> {
  const body = await readExactBody(request);
  if (body instanceof Response) return body;
  let payload: string;
  try {
    payload = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return jsonError(400, "invalid_utf8");
  }
  try {
    await verifyWebhookSignature({
      headers: request.headers,
      payload,
      secret,
    });
  } catch (error) {
    if (error instanceof WebhookVerificationError) {
      return jsonError(401, "invalid_signature");
    }
    throw error;
  }
  let instanceName = "invalid";
  let admission: RelayMessageAdmission | undefined;
  let serial: RelayMessageAdmission | undefined;
  let event: { id: string; type: string } | undefined;
  try {
    const decoded: unknown = JSON.parse(payload);
    if (!isRecord(decoded)) throw new TypeError("Invalid webhook envelope");
    const envelope = decoded as {
      agent_id?: unknown;
      event_id?: unknown;
      event_type?: unknown;
      data?: {
        id?: unknown;
        chat?: {
          id?: unknown;
        };
        chat_id?: unknown;
        call?: {
          chat_id?: unknown;
        };
        metadata?: Record<string, unknown>;
      };
    } & Record<string, unknown>;
    if (
      typeof envelope.event_id === "string"
      && typeof envelope.event_type === "string"
    ) {
      event = { id: envelope.event_id, type: envelope.event_type };
    }
    const chatId = envelope.data?.chat?.id ?? envelope.data?.chat_id
      ?? envelope.data?.call?.chat_id
      ?? (envelope.event_type === "chat.created" ? envelope.data?.id : undefined)
      ?? (String(envelope.event_type).startsWith("payment.")
        ? envelope.data?.metadata?.[PAYMENT_CHAT_METADATA_KEY]
        : undefined);
    if (typeof chatId === "string" && UUID.test(chatId)) {
      instanceName = `chat:${chatId}`;
    } else if (
      typeof envelope.agent_id === "string"
      && UUID.test(envelope.agent_id)
    ) {
      instanceName = `agent:${envelope.agent_id}`;
    }
    const ingress = relayMessageIngress(envelope, everyGroupMessage);
    if (ingress) {
      serial = {
        messageId: ingress.messageId,
        sentAt: ingress.sentAt,
        ...(ingress.fromAgent ? { fromAgent: true as const } : {}),
      };
      if (ingress.actionable) admission = serial;
    }
  } catch {
    // The adapter returns the canonical invalid_json response inside the
    // authenticated Agent. This fallback only chooses its isolated instance.
  }
  const url = request.url;
  const headers = new Headers(request.headers);
  if (serial) {
    headers.set(
      RELAY_MESSAGE_SERIAL_HEADER,
      formatRelayMessageIdentity(serial),
    );
  } else {
    headers.delete(RELAY_MESSAGE_SERIAL_HEADER);
  }
  if (admission) {
    headers.set(
      RELAY_MESSAGE_ADMISSION_HEADER,
      formatRelayMessageIdentity(admission),
    );
  } else {
    headers.delete(RELAY_MESSAGE_ADMISSION_HEADER);
  }
  const relayBody = body.slice().buffer as ArrayBuffer;
  return {
    instanceName,
    ...(admission ? { admission } : {}),
    ...(event
      ? {
        delivery: {
          ...(admission ? { admission } : {}),
          body: payload,
          eventId: event.id,
          eventType: event.type,
          // Persist only what the adapter needs to parse and repeat Standard
          // Webhooks verification. Arbitrary client headers do not become
          // durable data.
          headers: durableWebhookHeaders(headers),
          instanceName,
          ...(serial ? { serial } : {}),
          url,
        },
      }
      : {}),
    ...(event ? { event } : {}),
    ...(serial ? { serial } : {}),
    // Construct the body stream only for the Agent fetch context. A Request
    // created earlier cannot safely cross a Durable Object I/O boundary under
    // workerd.
    request: () =>
      new Request(url, {
        method: "POST",
        headers,
        body: relayBody,
      }),
  };
}

/**
 * Mark every group Message as addressed to this adapter when `enabled()` is
 * true, so a Think agent hears every group Message and decides whether to
 * reply or stay silent.
 */
export function withEveryGroupMessage(
  adapter: RelayAdapter,
  enabled: () => boolean,
): RelayAdapter {
  const parse = adapter.parseMessage.bind(adapter);
  adapter.parseMessage = (raw) => {
    const message = parse(raw);
    const chat = (raw.message as { chat?: { is_group?: unknown } } | undefined)?.chat;
    if (enabled() && raw.eventType === "message.received" && chat?.is_group === true) {
      message.isMention = true;
    }
    return message;
  };
  return adapter;
}
