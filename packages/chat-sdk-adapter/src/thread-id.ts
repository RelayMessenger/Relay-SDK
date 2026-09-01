import { ValidationError } from "@chat-adapter/shared";
import type { RelayThreadId } from "./types.js";

export const RELAY_THREAD_PREFIX = "relay:";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isRelayUuid(value: string): boolean {
  return UUID.test(value);
}

export function assertRelayUuid(value: string, label: string): void {
  if (!isRelayUuid(value)) {
    throw new ValidationError(
      "relay",
      `${label} must be a Relay UUID; received ${JSON.stringify(value)}`,
    );
  }
}

export function encodeRelayThreadId(data: RelayThreadId): string {
  assertRelayUuid(data.chatId, "chatId");
  return `${RELAY_THREAD_PREFIX}${data.chatId}`;
}

export function decodeRelayThreadId(threadId: string): RelayThreadId {
  if (!threadId.startsWith(RELAY_THREAD_PREFIX)) {
    throw new ValidationError(
      "relay",
      `not a Relay thread ID: ${JSON.stringify(threadId)}`,
    );
  }
  const chatId = threadId.slice(RELAY_THREAD_PREFIX.length);
  assertRelayUuid(chatId, "Relay thread chat ID");
  return { chatId };
}

export function relayChannelIdFromThreadId(threadId: string): string {
  return encodeRelayThreadId(decodeRelayThreadId(threadId));
}
