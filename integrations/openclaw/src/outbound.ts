// Durable outbound sends (doc 03 §5): every logical send carries an
// Idempotency-Key; internal retries and unknown-send reconciliation replay
// the same key, so a retry can never duplicate a visible message
// (server contract: commitMessage.ts idempotent replay).
import { createHash } from "node:crypto";
import { RelayApiError } from "./client.js";
import type { RelayClient } from "./client.js";
import type { RelayMessage } from "./types.js";

/**
 * Per-part text ceiling declared to core's renderer so long agent replies are
 * split into multiple messages instead of truncated (doc 03 §5 — the exact
 * Hermes-adapter bug). Server caps a text part at 8 KiB UTF-8
 * (server/src/domain/commitMessage.ts MAX_TEXT_BYTES); 2000 chars is safe for
 * any UTF-8 content (4 bytes/char worst case).
 */
export const RELAY_TEXT_CHUNK_LIMIT = 2_000;

const IDEMPOTENCY_KEY_MAX = 255;

/**
 * Idempotency key for one logical send. When core supplies a durable delivery
 * queue id, the key is a stable function of (queueId, partIndex) so internal
 * retries and reconciliation replay the exact same key; otherwise a fresh
 * UUID-based key is minted per logical send.
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
  return key.length > IDEMPOTENCY_KEY_MAX ? key.slice(0, IDEMPOTENCY_KEY_MAX) : key;
}

/**
 * Content-derived idempotency key for send paths that have no durable queue
 * id (compat outbound adapter, non-final block delivery). A caller retry with
 * the same target and text replays the same key, so the server commit stays
 * single. Tradeoff: an intentional identical duplicate send inside the
 * server's idempotency window is also collapsed — acceptable for these
 * delivery paths, where every retry is a transport retry, not a new intent.
 */
export function deriveRelayContentIdempotencyKey(params: {
  conversationId: string;
  text: string;
  replyToId?: string | null;
}): string {
  const digest = createHash("sha256")
    .update(`relay\0${params.conversationId}\0${params.replyToId ?? ""}\0${params.text}`)
    .digest("hex")
    .slice(0, 48);
  return `relay-send:h:${digest}`;
}

export type RelayOutboundSendResult = {
  messageId: string;
  message: RelayMessage;
};

export async function sendRelayText(params: {
  client: RelayClient;
  conversationId: string;
  text: string;
  replyToId?: string | null;
  idempotencyKey: string;
  signal?: AbortSignal;
}): Promise<RelayOutboundSendResult> {
  const result = await params.client.sendMessage({
    conversationId: params.conversationId,
    parts: [{ type: "text", text: params.text }],
    ...(params.replyToId ? { replyTo: { message_id: params.replyToId } } : {}),
    idempotencyKey: params.idempotencyKey,
    ...(params.signal ? { signal: params.signal } : {}),
  });
  return { messageId: result.messageId, message: result.message };
}

export type RelayUnknownSendVerdict =
  | { status: "sent"; messageId: string; message: RelayMessage }
  | { status: "not_sent" }
  | { status: "unresolved"; error?: string; retryable?: boolean };

/**
 * Reconcile a send whose platform outcome is unknown (doc 03 §5,
 * message/types.ts reconcileUnknownSend): replay the POST with the same
 * idempotency key and body. By server contract the replay either performs the
 * send exactly once or returns the originally committed message — either way
 * the visible outcome is a single message.
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
    return { status: "sent", messageId: result.messageId, message: result.message };
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
