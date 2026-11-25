import {
  AdapterError,
  AdapterRateLimitError,
  AuthenticationError,
  NetworkError,
  PermissionError,
  ResourceNotFoundError,
  ValidationError,
} from "@chat-adapter/shared";
import { Relay as SdkRelay, RelayAPIError } from "@relaymessenger/sdk";
import type { RelayCredential } from "./credentials.js";
import {
  resolveRelayCredential,
  validateStaticCredential,
} from "./credentials.js";
import { assertRelayUuid } from "./thread-id.js";
import type {
  RelayAttachment,
  RelayAttachmentAllocation,
  RelayChat,
  RelayChatLocation,
  RelayGetMessagesResult,
  RelayCreatePaymentRequest,
  RelayLocationRequestResponse,
  RelayMessage,
  RelayOutgoingPart,
  RelayPaymentRequest,
  RelayPaymentRequestList,
  RelayPaymentStatus,
  RelayReactionType,
  RelaySendMessageResponse,
} from "./types.js";

export const RELAY_DEFAULT_BASE_URL = "https://api.relayapp.im";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 250;
const MAX_RETRY_AFTER_SECONDS = 60;
const DEFAULT_MAX_DOWNLOAD_BYTES = 104_857_600;

export interface RelayClientOptions {
  /** Relay Agent Token or a resolver evaluated for every Relay API call. */
  token?: RelayCredential;
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Request timeout in milliseconds. Defaults to 15000. */
  timeoutMs?: number;
  /** Maximum retry attempts for transient failures. Defaults to 2. */
  maxRetries?: number;
  /** Base delay in milliseconds for exponential backoff. Defaults to 250. */
  retryBaseDelayMs?: number;
  /** Maximum byte size for `downloadAttachment`. Defaults to 104857600 (100 MiB). */
  maxDownloadBytes?: number;
}

export interface RelayDownloadOptions {
  attachmentId?: string;
  url: string;
  maxBytes?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export class RelayAttachmentTooLargeError extends ValidationError {
  readonly maxBytes: number;
  readonly actualBytes: number | undefined;

  constructor(label: string, maxBytes: number, actualBytes?: number) {
    super(
      "relay",
      actualBytes !== undefined
        ? `Relay attachment ${label} exceeds maximum download size of ${maxBytes} bytes (${actualBytes} bytes)`
        : `Relay attachment ${label} exceeds maximum download size of ${maxBytes} bytes`,
    );
    this.name = "RelayAttachmentTooLargeError";
    this.maxBytes = maxBytes;
    this.actualBytes = actualBytes;
  }
}

export interface RelayUploadOptions {
  body: Uint8Array<ArrayBuffer>;
  contentType: string;
  durationMs?: number;
  filename: string;
  height?: number;
  width?: number;
}

export class RelayApiError extends AdapterError {
  constructor(
    readonly status: number,
    readonly relayCode: string,
    message: string,
    readonly responseBody?: unknown,
  ) {
    super(message, "relay", relayCode);
    this.name = "RelayApiError";
  }
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function errorDetails(
  body: unknown,
  status: number,
): { code: string; message: string } {
  if (typeof body === "object" && body !== null) {
    const record = body as Record<string, unknown>;
    const error =
      typeof record.error === "object" && record.error !== null
        ? (record.error as Record<string, unknown>)
        : record;
    const code =
      typeof error.code === "string"
        ? error.code
        : typeof error.code === "number"
          ? String(error.code)
          : `http_${status}`;
    const message =
      typeof error.message === "string"
        ? error.message
        : `Relay API request failed with HTTP ${status}`;
    return { code, message };
  }
  return {
    code: `http_${status}`,
    message:
      typeof body === "string" && body
        ? body
        : `Relay API request failed with HTTP ${status}`,
  };
}

/**
 * `retry_after` is published by the Relay error contract as an integer number
 * of seconds and is "Only present on 429 rate limit errors"
 * (`contracts/relay-v1-openapi.yaml`, `ErrorDetail.retry_after`).
 */
function retryAfterSeconds(
  body: unknown,
  headerValue?: string | null,
): number | undefined {
  if (typeof body === "object" && body !== null) {
    const record = body as Record<string, unknown>;
    const error =
      typeof record.error === "object" && record.error !== null
        ? (record.error as Record<string, unknown>)
        : record;
    const value = error.retry_after;
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return value;
    }
  }
  if (headerValue !== undefined && headerValue !== null) {
    const trimmed = headerValue.trim();
    if (trimmed !== "") {
      const numeric = Number(trimmed);
      if (Number.isFinite(numeric) && numeric >= 0) return numeric;
      if (Number.isNaN(numeric)) {
        const parsedDate = Date.parse(trimmed);
        if (Number.isFinite(parsedDate)) {
          return Math.max(0, (parsedDate - Date.now()) / 1_000);
        }
      }
    }
  }
  return undefined;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function retryWaitMs(
  retryAfter: number | undefined,
  baseDelayMs: number,
  attempt: number,
): number {
  return retryAfter !== undefined
    ? Math.min(retryAfter, MAX_RETRY_AFTER_SECONDS) * 1_000
    : baseDelayMs * 2 ** attempt;
}

async function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return;
  if (signal?.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function readBoundedArrayBuffer(
  response: Response,
  maxBytes: number,
  label: string,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const lengthHeader = response.headers.get("content-length");
  if (lengthHeader !== null && lengthHeader.trim() !== "") {
    const declared = Number(lengthHeader);
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel().catch(() => {});
      throw new RelayAttachmentTooLargeError(label, maxBytes, declared);
    }
  }
  if (!response.body) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) {
      throw new RelayAttachmentTooLargeError(label, maxBytes, buffer.byteLength);
    }
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let onAbort: (() => void) | undefined;
  const aborted = signal
    ? new Promise<never>((_, reject) => {
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
      })
    : undefined;
  // Prevent unhandled rejection if aborted fires after normal completion.
  aborted?.catch(() => {});
  try {
    while (true) {
      if (signal?.aborted) throw signal.reason;
      const readPromise = reader.read();
      const { done, value } = aborted
        ? await Promise.race([readPromise, aborted])
        : await readPromise;
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new RelayAttachmentTooLargeError(label, maxBytes);
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}

const RESOURCE_BY_COLLECTION: Record<string, string> = {
  attachments: "attachment",
  chats: "chat",
  messages: "message",
};

/**
 * Name the resource a 404 is about from the path this client itself built.
 * Every Relay route is `/v1/{collection}/{id}/...`, so the owning resource is
 * the first collection segment and its ID is the segment after it.
 */
function resourceFromPath(path: string): {
  id?: string;
  type: string;
} {
  const segments = path.split("?")[0]!.split("/").filter(Boolean);
  const collection = segments[1];
  const type =
    (collection ? RESOURCE_BY_COLLECTION[collection] : undefined) ??
    "resource";
  const id = segments[2];
  return id ? { id: decodeURIComponent(id), type } : { type };
}

/**
 * Map a Relay API status onto the Chat SDK's shared error classes so a
 * consumer can catch `AdapterRateLimitError` and read `retryAfter`, or catch
 * `AuthenticationError`, without knowing Relay's HTTP vocabulary.
 *
 * `RelayApiError` stays the default: a status Relay defines but the shared
 * vocabulary has no class for — 409 idempotency conflict, for instance —
 * must keep its Relay status and code rather than be flattened into a
 * near-miss.
 */
export function relayHttpError(options: {
  body: unknown;
  path: string;
  status: number;
  retryAfter?: number;
}): AdapterError {
  const { body, path, status } = options;
  const details = errorDetails(body, status);
  switch (status) {
    case 400:
    case 422:
      return new ValidationError("relay", details.message);
    case 401:
      return new AuthenticationError("relay", details.message);
    case 403:
      return new PermissionError("relay", details.message, details.code);
    case 404: {
      const resource = resourceFromPath(path);
      return new ResourceNotFoundError(
        "relay",
        resource.type,
        resource.id,
      );
    }
    case 429:
      return new AdapterRateLimitError(
        "relay",
        options.retryAfter ?? retryAfterSeconds(body),
      );
    default:
      if (status >= 500) {
        return new NetworkError("relay", details.message);
      }
      return new RelayApiError(
        status,
        details.code,
        details.message,
        body,
      );
  }
}

function mapSdkError(error: unknown, path: string): never {
  if (error instanceof RelayAPIError) {
    if (error.status === undefined) {
      throw new NetworkError(
        "relay",
        error.message,
        error.cause instanceof Error ? error.cause : undefined,
      );
    }
    throw relayHttpError({
      body: error.body,
      path,
      status: error.status,
      ...(error.retryAfter !== undefined ? { retryAfter: error.retryAfter } : {}),
    });
  }
  throw error;
}

/**
 * Minimal client for the locked Relay v1 operations used by the adapter,
 * delegating HTTP transport, auth, timeouts, and retries to `@relaymessenger/sdk`.
 */
export class RelayClient {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly token: RelayCredential | undefined;
  private readonly timeoutMs: number;
  private readonly downloadTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly maxDownloadBytes: number;
  private readonly staticSdk: SdkRelay | undefined;

  constructor(options: RelayClientOptions = {}) {
    validateStaticCredential(options.token, "Relay Agent Token");
    this.token = options.token;
    this.baseUrl = trimTrailingSlash(
      options.baseUrl ?? RELAY_DEFAULT_BASE_URL,
    );
    const parsed = new URL(this.baseUrl);
    if (parsed.protocol !== "https:" && parsed.hostname !== "localhost") {
      throw new ValidationError(
        "relay",
        "Relay baseUrl must use HTTPS (localhost is allowed for tests)",
      );
    }
    const selected = options.fetch ?? globalThis.fetch;
    if (!selected) {
      throw new ValidationError(
        "relay",
        "A Web Fetch API implementation is required",
      );
    }
    // workerd's host fetch requires its global receiver.
    this.fetchImpl = selected.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.downloadTimeoutMs = options.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.retryBaseDelayMs =
      options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
    this.maxDownloadBytes =
      options.maxDownloadBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES;
    if (typeof options.token === "string") {
      this.staticSdk = this.buildSdk(options.token);
    }
  }

  private buildSdk(apiKey: string): SdkRelay {
    const sdkFetch: typeof fetch = (input, init) =>
      this.fetchImpl(input instanceof URL ? input.toString() : input, init);
    return new SdkRelay({
      apiKey,
      baseURL: this.baseUrl,
      fetch: sdkFetch,
      maxRetries: this.maxRetries,
      timeout: this.timeoutMs,
      retryBaseDelayMs: this.retryBaseDelayMs,
    });
  }

  private async sdk(): Promise<SdkRelay> {
    if (this.staticSdk) return this.staticSdk;
    const token = await resolveRelayCredential(
      this.token,
      "Relay Agent Token",
    );
    return this.buildSdk(token);
  }

  private async run<T>(
    path: string,
    operation: (sdk: SdkRelay) => Promise<T>,
  ): Promise<T> {
    const sdk = await this.sdk();
    try {
      return await operation(sdk);
    } catch (error) {
      return mapSdkError(error, path);
    }
  }

  async sendMessage(options: {
    chatId: string;
    idempotencyKey: string;
    parts: RelayOutgoingPart[];
    replyTo?: { messageId: string; partIndex?: number };
  }): Promise<RelaySendMessageResponse> {
    assertRelayUuid(options.chatId, "chatId");
    if (options.parts.length < 1 || options.parts.length > 100) {
      throw new ValidationError(
        "relay",
        "A Relay message requires 1–100 parts",
      );
    }
    if (
      options.idempotencyKey.length < 1 ||
      options.idempotencyKey.length > 255
    ) {
      throw new ValidationError(
        "relay",
        "Relay idempotency keys must contain 1–255 characters",
      );
    }
    if (options.replyTo) {
      assertRelayUuid(options.replyTo.messageId, "reply message ID");
    }
    const path = `/v1/chats/${encodeURIComponent(options.chatId)}/messages`;
    return this.run(path, (sdk) =>
      sdk.chats.messages.send(
        options.chatId,
        {
          message: {
            parts: options.parts,
            ...(options.replyTo
              ? {
                  reply_to: {
                    message_id: options.replyTo.messageId,
                    ...(options.replyTo.partIndex !== undefined
                      ? { part_index: options.replyTo.partIndex }
                      : {}),
                  },
                }
              : {}),
          },
        },
        {
          headers: { "Idempotency-Key": options.idempotencyKey },
        },
      ),
    );
  }

  async react(options: {
    customEmoji?: string;
    messageId: string;
    operation: "add" | "remove";
    partIndex?: number;
    type: RelayReactionType;
  }): Promise<void> {
    assertRelayUuid(options.messageId, "messageId");
    const path = `/v1/messages/${encodeURIComponent(options.messageId)}/reactions`;
    await this.run(path, (sdk) =>
      sdk.messages.addReaction(options.messageId, {
        operation: options.operation,
        type: options.type,
        ...(options.customEmoji ? { custom_emoji: options.customEmoji } : {}),
        ...(options.partIndex !== undefined
          ? { part_index: options.partIndex }
          : {}),
      }),
    );
  }

  /**
   * Create a payment request on the organization's connected Stripe account.
   * Send the returned `checkout_url` as a `payment` part.
   */
  async createPaymentRequest(
    body: RelayCreatePaymentRequest,
    options: { idempotencyKey?: string } = {},
  ): Promise<RelayPaymentRequest> {
    return this.run("/v1/payment_requests", (sdk) =>
      sdk.paymentRequests.create(
        body,
        options.idempotencyKey
          ? { idempotencyKey: options.idempotencyKey }
          : undefined,
      ),
    );
  }

  async listPaymentRequests(options: {
    cursor?: string;
    limit?: number;
    status?: RelayPaymentStatus;
  } = {}): Promise<RelayPaymentRequestList> {
    const query = {
      ...(options.cursor ? { cursor: options.cursor } : {}),
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
      ...(options.status ? { status: options.status } : {}),
    };
    return this.run("/v1/payment_requests", (sdk) =>
      sdk.paymentRequests.list(query),
    );
  }

  async getPaymentRequest(paymentRequestId: string): Promise<RelayPaymentRequest> {
    assertRelayUuid(paymentRequestId, "paymentRequestId");
    const path = `/v1/payment_requests/${encodeURIComponent(paymentRequestId)}`;
    return this.run(path, (sdk) =>
      sdk.paymentRequests.retrieve(paymentRequestId),
    );
  }

  /** Cancel a request that has not been paid; the card changes in place. */
  async cancelPaymentRequest(paymentRequestId: string): Promise<RelayPaymentRequest> {
    assertRelayUuid(paymentRequestId, "paymentRequestId");
    const path = `/v1/payment_requests/${encodeURIComponent(paymentRequestId)}/cancel`;
    return this.run(path, (sdk) =>
      sdk.paymentRequests.cancel(paymentRequestId),
    );
  }

  /**
   * Ask the person in this one-to-one chat to share their location. The chat
   * gets a Message from the agent with one `location_request` part; no
   * position comes back. Wait for `location.sharing.started`, then read it
   * with `getLocation`. Relay answers 409 while the person already shares,
   * and in a group chat; 429 after one request in the same chat within 60 s.
   */
  async requestLocation(chatId: string): Promise<RelayLocationRequestResponse> {
    assertRelayUuid(chatId, "chatId");
    const path = `/v1/chats/${encodeURIComponent(chatId)}/location/request`;
    return this.run(path, (sdk) => sdk.chats.location.request(chatId));
  }

  /**
   * Read where everyone sharing with the agent in this chat is now: one
   * GeoJSON Feature per person, coordinates `[longitude, latitude]`.
   * `data.features` is empty when nobody shares.
   */
  async getLocation(chatId: string): Promise<RelayChatLocation> {
    assertRelayUuid(chatId, "chatId");
    const path = `/v1/chats/${encodeURIComponent(chatId)}/location`;
    return this.run(path, (sdk) => sdk.chats.location.retrieve(chatId));
  }

  async setTyping(chatId: string, active: boolean): Promise<void> {
    assertRelayUuid(chatId, "chatId");
    const path = `/v1/chats/${encodeURIComponent(chatId)}/typing`;
    await this.run(path, (sdk) =>
      active ? sdk.chats.startTyping(chatId) : sdk.chats.stopTyping(chatId),
    );
  }

  async markChatRead(
    chatId: string,
    options?: { maxRetries?: number },
  ): Promise<void> {
    assertRelayUuid(chatId, "chatId");
    const path = `/v1/chats/${encodeURIComponent(chatId)}/read`;
    await this.run(path, (sdk) =>
      sdk.chats.markAsRead(
        chatId,
        options?.maxRetries !== undefined
          ? { maxRetries: options.maxRetries }
          : undefined,
      ),
    );
  }

  async getChat(chatId: string): Promise<RelayChat> {
    assertRelayUuid(chatId, "chatId");
    const path = `/v1/chats/${encodeURIComponent(chatId)}`;
    return this.run(path, (sdk) => sdk.chats.retrieve(chatId));
  }

  async getMessages(options: {
    chatId: string;
    cursor?: string;
    limit?: number;
  }): Promise<RelayGetMessagesResult> {
    assertRelayUuid(options.chatId, "chatId");
    let limit: number | undefined;
    if (options.limit !== undefined) {
      limit = Math.trunc(options.limit);
      if (limit < 1 || limit > 100) {
        throw new ValidationError(
          "relay",
          "Relay message history limit must be between 1 and 100",
        );
      }
    }
    const path = `/v1/chats/${encodeURIComponent(options.chatId)}/messages`;
    const page = await this.run(path, (sdk) =>
      sdk.chats.messages.list(options.chatId, {
        ...(options.cursor ? { cursor: options.cursor } : {}),
        ...(limit !== undefined ? { limit } : {}),
      }),
    );
    return {
      messages: page.data,
      next_cursor: page.nextCursor,
    };
  }

  async getMessage(messageId: string): Promise<RelayMessage> {
    assertRelayUuid(messageId, "messageId");
    const path = `/v1/messages/${encodeURIComponent(messageId)}`;
    return this.run(path, (sdk) => sdk.messages.retrieve(messageId));
  }

  /**
   * Read Attachment metadata, including a freshly minted `download_url`.
   *
   * Relay mints the download link at request time, so this is how an expired
   * link is replaced. The route authorizes any Chat participant who could read
   * the Message the Attachment belongs to, not only its owner.
   */
  async getAttachment(attachmentId: string): Promise<RelayAttachment> {
    assertRelayUuid(attachmentId, "attachmentId");
    const path = `/v1/attachments/${encodeURIComponent(attachmentId)}`;
    return this.run(path, (sdk) => sdk.attachments.retrieve(attachmentId));
  }

  async allocateAttachment(
    options: Omit<RelayUploadOptions, "body"> & { sizeBytes: number },
  ): Promise<RelayAttachmentAllocation> {
    return this.run("/v1/attachments", (sdk) =>
      sdk.attachments.create({
        filename: options.filename,
        content_type: options.contentType as Parameters<
          SdkRelay["attachments"]["create"]
        >[0]["content_type"],
        size_bytes: options.sizeBytes,
        ...(options.durationMs !== undefined
          ? { duration_ms: options.durationMs }
          : {}),
        ...(options.width !== undefined && options.height !== undefined
          ? { width: options.width, height: options.height }
          : {}),
      }),
    );
  }

  async uploadAttachment(
    options: RelayUploadOptions,
  ): Promise<RelayAttachmentAllocation> {
    if (options.body.byteLength < 1 || options.body.byteLength > 104_857_600) {
      throw new ValidationError(
        "relay",
        "Relay attachments must contain 1–104857600 bytes",
      );
    }
    const sdk = await this.sdk();
    let allocation: RelayAttachmentAllocation;
    try {
      allocation = await sdk.attachments.create({
        filename: options.filename,
        content_type: options.contentType as Parameters<
          SdkRelay["attachments"]["create"]
        >[0]["content_type"],
        size_bytes: options.body.byteLength,
        ...(options.durationMs !== undefined
          ? { duration_ms: options.durationMs }
          : {}),
        ...(options.width !== undefined && options.height !== undefined
          ? { width: options.width, height: options.height }
          : {}),
      });
    } catch (error) {
      return mapSdkError(error, "/v1/attachments");
    }

    try {
      await sdk.attachments.upload(allocation, options.body);
      return allocation;
    } catch (error) {
      if (error instanceof RelayAPIError) {
        if (error.status === undefined) {
          throw new NetworkError(
            "relay",
            error.message,
            error.cause instanceof Error ? error.cause : undefined,
          );
        }
        const details = errorDetails(error.body, error.status);
        throw new RelayApiError(
          error.status,
          details.code,
          details.message,
          error.body,
        );
      }
      throw error;
    }
  }

  /**
   * Download the bytes of an inbound Relay media part.
   *
   * A Relay media URL is a sealed download capability: the transfer route is
   * unauthenticated, so no Agent Token is sent, and the capability expires 60
   * minutes after Relay minted it. A download after that window fails with
   * HTTP 404; `getAttachment` mints a replacement.
   */
  async downloadAttachment(options: RelayDownloadOptions): Promise<ArrayBuffer> {
    const label = options.attachmentId ?? options.url;
    const maxBytes = options.maxBytes ?? this.maxDownloadBytes;
    const timeoutMs = options.timeoutMs ?? this.downloadTimeoutMs;

    for (let attempt = 0; ; attempt += 1) {
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const signal = options.signal
        ? AbortSignal.any([options.signal, timeoutSignal])
        : timeoutSignal;
      let response: Response;
      try {
        response = await this.fetchImpl(options.url, { signal });
      } catch (error) {
        if (options.signal?.aborted) throw error;
        if (isAbortError(error) && !timeoutSignal.aborted) throw error;
        if (attempt < this.maxRetries) {
          await delay(this.retryBaseDelayMs * 2 ** attempt, options.signal);
          continue;
        }
        throw new NetworkError(
          "relay",
          timeoutSignal.aborted
            ? `Timed out downloading Relay attachment ${label} after ${timeoutMs}ms`
            : `Network error downloading Relay attachment ${label}`,
          error instanceof Error ? error : undefined,
        );
      }
      if (!response.ok) {
        const body = await parseResponseBody(response);
        const retryAfter = retryAfterSeconds(
          body,
          response.headers.get("retry-after"),
        );
        if (isRetryableStatus(response.status) && attempt < this.maxRetries) {
          await delay(
            retryWaitMs(retryAfter, this.retryBaseDelayMs, attempt),
            options.signal,
          );
          continue;
        }
        const details = errorDetails(body, response.status);
        throw new RelayApiError(
          response.status,
          details.code,
          `Failed to download Relay attachment ${label}: `
            + `HTTP ${response.status}`,
          body,
        );
      }
      try {
        return await readBoundedArrayBuffer(response, maxBytes, label, signal);
      } catch (error) {
        if (error instanceof RelayAttachmentTooLargeError) throw error;
        if (options.signal?.aborted) throw error;
        if (isAbortError(error) && !timeoutSignal.aborted) throw error;
        if (attempt < this.maxRetries) {
          await delay(this.retryBaseDelayMs * 2 ** attempt, options.signal);
          continue;
        }
        throw new NetworkError(
          "relay",
          timeoutSignal.aborted
            ? `Timed out downloading Relay attachment ${label} after ${timeoutMs}ms`
            : `Network error downloading Relay attachment ${label}`,
          error instanceof Error ? error : undefined,
        );
      }
    }
  }
}
