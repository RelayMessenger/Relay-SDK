import { createHash, randomUUID } from "node:crypto";
import {
  Relay,
  RelayAPIError,
  type MessageSendResponse,
} from "@relaymessenger/sdk";
import type { ResolvedRelayAccount } from "./types.js";

export const RELAY_TEXT_CHUNK_LIMIT = 10_000;
const IDEMPOTENCY_KEY_MAX_LENGTH = 255;

export function createRelaySdkClient(
  account: Pick<ResolvedRelayAccount, "baseUrl" | "token">,
): Relay {
  return new Relay({
    apiKey: account.token,
    baseURL: account.baseUrl,
  });
}

export function deriveRelayIdempotencyKey(params: {
  deliveryQueueId?: string | undefined;
  deliveryPartIndex?: number | undefined;
  random?: () => string;
}): string {
  const queueId = params.deliveryQueueId?.trim();
  const raw = queueId
    ? `relay-openclaw:${queueId}:${params.deliveryPartIndex ?? 0}`
    : `relay-openclaw:${(params.random ?? randomUUID)()}`;
  return raw.length <= IDEMPOTENCY_KEY_MAX_LENGTH
    ? raw
    : `relay-openclaw:sha256:${createHash("sha256").update(raw).digest("hex")}`;
}

export async function sendRelayText(params: {
  relay: Pick<Relay, "chats">;
  chatId: string;
  text: string;
  replyToId?: string | null | undefined;
  idempotencyKey: string;
  signal?: AbortSignal;
  onPlatformSendDispatch?: () => Promise<void>;
}): Promise<MessageSendResponse> {
  await params.onPlatformSendDispatch?.();
  return await params.relay.chats.messages.send(
    params.chatId,
    {
      message: {
        parts: [{ type: "text", value: params.text }],
        idempotency_key: params.idempotencyKey,
        ...(params.replyToId
          ? { reply_to: { message_id: params.replyToId } }
          : {}),
      },
    },
    params.signal ? { signal: params.signal } : undefined,
  );
}

export function classifyUnknownRelaySend(error: unknown): {
  status: "not_sent" | "unresolved";
  error?: string;
  retryable?: boolean;
} {
  if (!(error instanceof RelayAPIError)) {
    return {
      status: "unresolved",
      error: error instanceof Error ? error.message : String(error),
      retryable: true,
    };
  }
  if (error.retryable) {
    return {
      status: "unresolved",
      error: error.message,
      retryable: true,
    };
  }
  if (error.status === 409) {
    return {
      status: "unresolved",
      error: error.message,
      retryable: false,
    };
  }
  return { status: "not_sent" };
}
