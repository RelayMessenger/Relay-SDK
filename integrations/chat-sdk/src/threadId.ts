import type { RelayThreadId } from "./types.js";

/**
 * Relay thread ids are `relay:{conversation_id}`. A Relay conversation has no
 * enclosing channel, so the channel id is the same string. Both are written
 * out here rather than left to the Chat SDK defaults, because the default
 * channel derivation keeps the first two colon-separated segments and that
 * only happens to be correct for this shape.
 */
export const RELAY_THREAD_PREFIX = "relay:";

export function encodeRelayThreadId(platformData: RelayThreadId): string {
  const conversationId = platformData.conversationId;
  if (!conversationId) {
    throw new Error("conversationId is required to encode a Relay thread id");
  }
  return `${RELAY_THREAD_PREFIX}${conversationId}`;
}

export function decodeRelayThreadId(threadId: string): RelayThreadId {
  if (!threadId.startsWith(RELAY_THREAD_PREFIX)) {
    throw new Error(`not a Relay thread id: ${threadId}`);
  }
  const conversationId = threadId.slice(RELAY_THREAD_PREFIX.length);
  if (!conversationId) {
    throw new Error(`Relay thread id carries no conversation id: ${threadId}`);
  }
  return { conversationId };
}

export function relayChannelIdFromThreadId(threadId: string): string {
  return encodeRelayThreadId(decodeRelayThreadId(threadId));
}
