// Outbound sends. One send is one message, and the `msg_` id minted here IS
// that message's identity and the send's only retry key: Relay replays a
// repeat of the same id instead of committing a second message, so a retry
// cannot duplicate a visible reply. No Idempotency-Key header is involved.
import { RelayApiError, relayId } from "./client.js";
import type { RelayClient, RelaySentMessage } from "./client.js";

/**
 * Per-part text ceiling declared to core's renderer so long agent replies are
 * split into multiple messages instead of truncated. Server caps a text part at 8 KiB UTF-8
 * (server/src/domain/commitMessage.ts MAX_TEXT_BYTES); 2000 chars is safe for
 * any UTF-8 content (4 bytes/char worst case).
 */
export const RELAY_TEXT_CHUNK_LIMIT = 2_000;

export type RelayOutboundSendResult = {
  /** The id the message committed under — the one this send minted. */
  messageId: string;
  /** The committed message, as the server echoed it back. */
  message: RelaySentMessage;
};

export async function sendRelayText(params: {
  client: RelayClient;
  conversationId: string;
  text: string;
  replyToId?: string | null;
  /** Reuse an id across attempts at ONE logical send; omit for a fresh one. */
  messageId?: string;
  signal?: AbortSignal;
}): Promise<RelayOutboundSendResult> {
  // Minted once, outside the loop. Minting per attempt is how you send the
  // same reply twice.
  const messageId = params.messageId ?? relayId("msg");
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const result = await params.client.sendMessage({
        conversationId: params.conversationId,
        messageId,
        parts: [{ type: "text", text: params.text }],
        ...(params.replyToId ? { replyTo: { message_id: params.replyToId } } : {}),
        ...(params.signal ? { signal: params.signal } : {}),
      });
      return { messageId: result.messageId, message: result.message };
    } catch (error) {
      lastError = error;
      if (!(error instanceof RelayApiError) || !error.retryable || params.signal?.aborted) {
        throw error;
      }
    }
  }
  throw lastError;
}
