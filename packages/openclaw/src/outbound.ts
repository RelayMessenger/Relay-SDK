import { createHash, randomUUID } from "node:crypto";
import {
  answerMessages,
  createPaymentPart,
  indexedIdempotencyKey,
  Relay,
  RelayAPIError,
  type MessageSendResponse,
  type SupportedContentType,
} from "@relaymessenger/sdk";
import { buildOutboundMediaLoadOptions, type OutboundMediaAccess } from "openclaw/plugin-sdk/media-runtime";
import { loadWebMedia } from "openclaw/plugin-sdk/web-media";
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

/**
 * OpenClaw hands the agent's words as text, so buttons ride in them as the
 * SDK's fenced block, lifted here into the buttons part, and a link written
 * alone on a line goes out as its own link Message. A block that cannot be
 * read stays in the words and is reported through `onButtonsError`. Without
 * a block or a link line the words go exactly as OpenClaw handed them, in one
 * Message; the response is the first Message's, the one the reply anchors to.
 */
export async function sendRelayText(params: {
  relay: Pick<Relay, "chats" | "paymentRequests">;
  chatId: string;
  text: string;
  replyToId?: string | null | undefined;
  idempotencyKey: string;
  signal?: AbortSignal;
  onPlatformSendDispatch?: () => Promise<void>;
  onButtonsError?: (error: string) => void;
}): Promise<MessageSendResponse> {
  await params.onPlatformSendDispatch?.();
  const { messages, payment, error } = answerMessages(params.text);
  if (error) params.onButtonsError?.(error);
  if (messages.length === 0 && !payment) messages.push([{ type: "text", value: params.text }]);
  if (payment) {
    // Created with the card's own key, so a retry of this delivery returns
    // the same request. A refusal after words went out is reported and the
    // words stand; with nothing sent yet, it is the delivery's own error.
    const key = indexedIdempotencyKey(params.idempotencyKey, messages.length);
    try {
      messages.push([await createPaymentPart(params.relay, payment, key, params.signal ? { signal: params.signal } : undefined)]);
    } catch (refusal) {
      if (!(refusal instanceof RelayAPIError) || refusal.retryable || messages.length === 0) throw refusal;
      params.onButtonsError?.(`the payment was not sent: ${refusal.message}`);
    }
  }
  let first: MessageSendResponse | undefined;
  for (const [index, parts] of messages.entries()) {
    const response = await params.relay.chats.messages.send(
      params.chatId,
      {
        message: {
          parts,
          idempotency_key: indexedIdempotencyKey(params.idempotencyKey, index),
          ...(index === 0 && params.replyToId
            ? { reply_to: { message_id: params.replyToId } }
            : {}),
        },
      },
      params.signal ? { signal: params.signal } : undefined,
    );
    first ??= response;
  }
  return first!;
}

/** Relay's attachment limit (contracts/relay-v1-openapi.yaml, AttachmentCreateParams). */
export const RELAY_MEDIA_MAX_BYTES = 100 * 1024 * 1024;

/** The bytes, type and name of one outbound file, as OpenClaw's loader returns them. */
export interface RelayMediaFile {
  buffer: Buffer;
  contentType?: string;
  fileName?: string;
}

/**
 * Loads the file OpenClaw hands a channel (a URL or an allowed local path)
 * through OpenClaw's own media policy, the way its Telegram channel does.
 */
export const loadRelayMedia = (params: {
  mediaUrl: string;
  mediaAccess?: OutboundMediaAccess | undefined;
  mediaLocalRoots?: readonly string[] | undefined;
  mediaReadFile?: ((filePath: string) => Promise<Buffer>) | undefined;
}): Promise<RelayMediaFile> => loadWebMedia(params.mediaUrl, buildOutboundMediaLoadOptions({
  maxBytes: RELAY_MEDIA_MAX_BYTES,
  ...(params.mediaAccess ? { mediaAccess: params.mediaAccess } : {}),
  ...(params.mediaLocalRoots ? { mediaLocalRoots: params.mediaLocalRoots } : {}),
  ...(params.mediaReadFile ? { mediaReadFile: params.mediaReadFile } : {}),
}));

/**
 * Sends one file as a media Message: Relay takes an upload, then a Message
 * whose one part names it. Words OpenClaw sends with the file go first,
 * through `sendRelayText`, so their component blocks and link lines are read
 * as for any answer. The response is the media Message's.
 */
export async function sendRelayMedia(params: {
  relay: Pick<Relay, "chats" | "paymentRequests" | "attachments">;
  chatId: string;
  text?: string | undefined;
  file: RelayMediaFile;
  replyToId?: string | null | undefined;
  idempotencyKey: string;
  signal?: AbortSignal;
  onPlatformSendDispatch?: () => Promise<void>;
}): Promise<MessageSendResponse> {
  const options = params.signal ? { signal: params.signal } : undefined;
  const words = params.text?.trim()
    ? await sendRelayText({
      relay: params.relay,
      chatId: params.chatId,
      text: params.text,
      replyToId: params.replyToId,
      idempotencyKey: indexedIdempotencyKey(params.idempotencyKey, 1),
      ...(params.signal ? { signal: params.signal } : {}),
      ...(params.onPlatformSendDispatch ? { onPlatformSendDispatch: params.onPlatformSendDispatch } : {}),
    })
    : (await params.onPlatformSendDispatch?.(), undefined);
  const allocation = await params.relay.attachments.create({
    filename: params.file.fileName || "file",
    content_type: (params.file.contentType || "application/octet-stream") as SupportedContentType,
    size_bytes: params.file.buffer.byteLength,
  }, options);
  await params.relay.attachments.upload(allocation, new Uint8Array(params.file.buffer), options);
  return params.relay.chats.messages.send(params.chatId, {
    message: {
      parts: [{ type: "media", attachment_id: allocation.attachment_id }],
      idempotency_key: params.idempotencyKey,
      ...(!words && params.replyToId ? { reply_to: { message_id: params.replyToId } } : {}),
    },
  }, options);
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
