// Durable outbound sends: every logical send carries an
// Idempotency-Key; internal retries and unknown-send reconciliation replay
// the same key, so a retry can never duplicate a visible message
// (server contract: commitMessage.ts idempotent replay).
import { createHash } from "node:crypto";
import { RelayApiError } from "./client.js";
import type { RelayClient } from "./client.js";
import type { RelayMessage } from "./types.js";

/**
 * Per-part text ceiling declared to core's renderer so long agent replies are
 * split into multiple messages instead of truncated. Server caps a text part at 8 KiB UTF-8
 * (server/src/domain/commitMessage.ts MAX_TEXT_BYTES); 2000 chars is safe for
 * any UTF-8 content (4 bytes/char worst case).
 */
export const RELAY_TEXT_CHUNK_LIMIT = 2_000;

const IDEMPOTENCY_KEY_MAX = 255;

/**
 * Idempotency key for one logical send. When core supplies a durable delivery
 * queue id, the key is a stable function of (queueId, partIndex) so internal
 * retries and reconciliation replay the exact same key. Without a queue id a
 * fresh key is minted: identical intentional sends must remain distinct.
 */
export function deriveRelayIdempotencyKey(params: {
  deliveryQueueId?: string;
  deliveryPartIndex?: number;
  random?: () => string;
}): string {
  const queueId = params.deliveryQueueId?.trim();
  const key = queueId
    ? `relay-send:${queueId}:${params.deliveryPartIndex ?? 0}`
    : `relay-send:${(params.random ?? (() => crypto.randomUUID()))()}`;
  // Server accepts 8-255 chars; the prefix guarantees the minimum.
  if (key.length <= IDEMPOTENCY_KEY_MAX) {
    return key;
  }
  // Preserve uniqueness when an opaque core queue id is unusually long; a
  // simple prefix slice could erase the part index and collapse two chunks.
  return `relay-send:h:${createHash("sha256").update(key).digest("hex")}`;
}

export type RelayOutboundSendResult = {
  /** Id of the first committed message; core's receipt APIs name one id. */
  messageId: string;
  /**
   * Every message the send committed, in display order. A single text part
   * commits exactly one, but the 202 is always an array and the receipt
   * should name everything the server stored.
   */
  messages: RelayMessage[];
};

export async function sendRelayText(params: {
  client: RelayClient;
  conversationId: string;
  text: string;
  replyToId?: string | null;
  idempotencyKey: string;
  signal?: AbortSignal;
}): Promise<RelayOutboundSendResult> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const result = await params.client.sendMessage({
        conversationId: params.conversationId,
        parts: [{ type: "text", text: params.text }],
        ...(params.replyToId ? { replyTo: { message_id: params.replyToId } } : {}),
        idempotencyKey: params.idempotencyKey,
        ...(params.signal ? { signal: params.signal } : {}),
      });
      const first = result.messages[0];
      if (!first) {
        throw new RelayApiError("relay: 202 carried no messages", { kind: "retryable" });
      }
      return { messageId: first.id, messages: result.messages };
    } catch (error) {
      lastError = error;
      if (!(error instanceof RelayApiError) || !error.retryable || params.signal?.aborted) {
        throw error;
      }
    }
  }
  throw lastError;
}

export type RelayUnknownSendVerdict =
  | { status: "sent"; messageId: string; messages: RelayMessage[] }
  | { status: "not_sent" }
  | { status: "unresolved"; error?: string; retryable?: boolean };

/**
 * Reconcile a send whose platform outcome is unknown: replay the POST with the
 * same idempotency key and body. By server contract the replay either performs
 * the send exactly once or returns the originally committed messages — either
 * way the visible outcome is the one set of messages the key names, never a
 * duplicate.
 */
export async function reconcileRelayUnknownSend(params: {
  client: RelayClient;
  conversationId: string;
  text: string;
  replyToId?: string | null;
  idempotencyKey: string;
}): Promise<RelayUnknownSendVerdict> {
  try {
    const result = await sendRelayText({
      client: params.client,
      conversationId: params.conversationId,
      text: params.text,
      replyToId: params.replyToId ?? null,
      idempotencyKey: params.idempotencyKey,
    });
    return { status: "sent", messageId: result.messageId, messages: result.messages };
  } catch (error) {
    if (error instanceof RelayApiError) {
      if (error.kind === "conflict") {
        // Key already used with a different request body: the original send
        // reached the server but we cannot recover its receipt. Do not retry —
        // a retry with a fresh key would duplicate the visible message.
        return { status: "unresolved", error: error.message, retryable: false };
      }
      if (error.retryable) {
        return { status: "unresolved", error: error.message, retryable: true };
      }
      if (error.kind === "auth") {
        return { status: "unresolved", error: error.message, retryable: false };
      }
      // Deterministic rejection (403/404/422): the original request would have
      // been rejected identically, so nothing reached the conversation.
      return { status: "not_sent" };
    }
    return { status: "unresolved", error: String(error), retryable: true };
  }
}
