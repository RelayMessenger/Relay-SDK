import { ValidationError } from "@chat-adapter/shared";
import type {
  RelayReactionEvent,
  RelayWebhookEnvelope,
  RelayWebhookEventType,
  RelayWebhookMessageEvent,
} from "./types.js";
import {
  RELAY_API_VERSION,
  RELAY_WEBHOOK_EVENT_TYPES,
  RELAY_WEBHOOK_VERSION,
} from "./types.js";
import { isRelayUuid } from "./thread-id.js";

const EVENT_TYPES = new Set<string>(RELAY_WEBHOOK_EVENT_TYPES);
// One Message may carry 100 text parts of 10,000 UTF-16 units. JSON escaping
// can expand a valid text unit to six ASCII bytes, before envelope metadata.
// Eight MiB accepts that locked maximum while still bounding untrusted input.
export const MAX_WEBHOOK_BODY_BYTES = 8 * 1_048_576;

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function isDateTime(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value))
  );
}

export function parseWebhookEnvelope(
  value: unknown,
): RelayWebhookEnvelope {
  if (!isRecord(value)) {
    throw new ValidationError(
      "relay",
      "Relay webhook body must be an object",
    );
  }
  if (
    value.api_version !== RELAY_API_VERSION ||
    value.webhook_version !== RELAY_WEBHOOK_VERSION ||
    typeof value.event_type !== "string" ||
    !EVENT_TYPES.has(value.event_type) ||
    typeof value.event_id !== "string" ||
    !isRelayUuid(value.event_id) ||
    typeof value.agent_id !== "string" ||
    !isRelayUuid(value.agent_id) ||
    typeof value.trace_id !== "string" ||
    !value.trace_id ||
    !isDateTime(value.created_at) ||
    !isRecord(value.data)
  ) {
    throw new ValidationError(
      "relay",
      `Webhook envelope must match Relay v1/${RELAY_WEBHOOK_VERSION}`,
    );
  }
  return value as unknown as RelayWebhookEnvelope;
}

function isHandle(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    isRelayUuid(value.id) &&
    typeof value.handle === "string" &&
    (value.kind === "user" || value.kind === "agent")
  );
}

export function parseWebhookMessageEvent(
  data: Record<string, unknown>,
): RelayWebhookMessageEvent {
  if (
    !isRecord(data.chat) ||
    typeof data.chat.id !== "string" ||
    !isRelayUuid(data.chat.id) ||
    typeof data.id !== "string" ||
    !isRelayUuid(data.id) ||
    (data.direction !== "inbound" &&
      data.direction !== "outbound") ||
    !isHandle(data.sender_handle) ||
    !Array.isArray(data.parts)
  ) {
    throw new ValidationError(
      "relay",
      "message webhook data does not match the locked MessageEvent contract",
    );
  }
  return data as unknown as RelayWebhookMessageEvent;
}

export function parseReactionEvent(
  data: Record<string, unknown>,
): RelayReactionEvent {
  if (
    typeof data.chat_id !== "string" ||
    !isRelayUuid(data.chat_id) ||
    typeof data.message_id !== "string" ||
    !isRelayUuid(data.message_id) ||
    !isHandle(data.from_handle) ||
    !Number.isInteger(data.part_index) ||
    (data.part_index as number) < 0 ||
    typeof data.is_from_me !== "boolean" ||
    typeof data.reaction_type !== "string" ||
    ![
      "love",
      "like",
      "dislike",
      "laugh",
      "emphasize",
      "question",
      "custom",
    ].includes(data.reaction_type) ||
    !isDateTime(data.reacted_at)
  ) {
    throw new ValidationError(
      "relay",
      "reaction webhook data does not match the locked ReactionEventBase contract",
    );
  }
  return data as unknown as RelayReactionEvent;
}

export function assertExhaustiveEvent(
  eventType: never,
): never {
  throw new Error(`Unhandled Relay webhook event: ${eventType as string}`);
}

export async function readWebhookBody(request: Request): Promise<string> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_WEBHOOK_BODY_BYTES) {
      await reader.cancel();
      throw new RangeError("Relay webhook body exceeds 8 MiB");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export function isMessageEventType(
  value: RelayWebhookEventType,
): value is
  | "message.sent"
  | "message.received"
  | "message.read"
  | "message.delivered" {
  return value.startsWith("message.");
}
