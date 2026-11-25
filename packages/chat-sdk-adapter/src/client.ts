import {
  AdapterError,
  AdapterRateLimitError,
  AuthenticationError,
  NetworkError,
  PermissionError,
  ResourceNotFoundError,
  ValidationError,
} from "@chat-adapter/shared";
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
 * (`contracts/relay-openapi.yaml`, `ErrorDetail.retry_after`).
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

/**
 * Minimal client for only the locked Relay v1 operations used by the adapter.
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
  }

  private async request<T>(
    path: string,
    init: RequestInit,
    options: { retryable?: boolean; maxRetries?: number } = {},
  ): Promise<T> {
    const method = (init.method ?? "GET").toUpperCase();
    const requestHeaders = new Headers(init.headers);
    const maxRetries = options.maxRetries ?? this.maxRetries;
    const mayRetry =
      options.retryable === true ||
      method === "GET" ||
      method === "PUT" ||
      method === "DELETE" ||
      Boolean(requestHeaders.get("idempotency-key")?.trim());

    for (let attempt = 0; ; attempt += 1) {
      const token = await resolveRelayCredential(
        this.token,
        "Relay Agent Token",
      );
      const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
      const signal = init.signal
        ? AbortSignal.any([init.signal, timeoutSignal])
        : timeoutSignal;
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          ...init,
          signal,
          headers: {
            Authorization: `Bearer ${token}`,
            ...Object.fromEntries(requestHeaders.entries()),
          },
        });
      } catch (error) {
        if (init.signal?.aborted) throw error;
        if (isAbortError(error) && !timeoutSignal.aborted) throw error;
        if (mayRetry && attempt < maxRetries) {
          await delay(this.retryBaseDelayMs * 2 ** attempt, init.signal ?? undefined);
          continue;
        }
        throw new NetworkError(
          "relay",
          timeoutSignal.aborted
            ? `Relay API request timed out after ${this.timeoutMs}ms`
            : "Network error calling the Relay API",
          error instanceof Error ? error : undefined,
        );
      }
      const body = await parseResponseBody(response);
      if (response.ok) return body as T;
      const retryAfter = retryAfterSeconds(
        body,
        response.headers.get("retry-after"),
      );
      if (mayRetry && isRetryableStatus(response.status) && attempt < maxRetries) {
        await delay(
          retryWaitMs(retryAfter, this.retryBaseDelayMs, attempt),
          init.signal ?? undefined,
        );
        continue;
      }
      throw relayHttpError({
        body,
        path,
        status: response.status,
        ...(retryAfter !== undefined ? { retryAfter } : {}),
      });
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
    return this.request<RelaySendMessageResponse>(
      `/v1/chats/${encodeURIComponent(options.chatId)}/messages`,
      {
        body: JSON.stringify({
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
        }),
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": options.idempotencyKey,
        },
        method: "POST",
      },
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
    await this.request<void>(
      `/v1/messages/${encodeURIComponent(options.messageId)}/reactions`,
      {
        body: JSON.stringify({
          operation: options.operation,
          type: options.type,
          ...(options.customEmoji
            ? { custom_emoji: options.customEmoji }
            : {}),
          ...(options.partIndex !== undefined
            ? { part_index: options.partIndex }
            : {}),
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      },
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
    return this.request<RelayPaymentRequest>("/v1/payment_requests", {
      body: JSON.stringify(body),
      headers: {
        "Content-Type": "application/json",
        ...(options.idempotencyKey
          ? { "Idempotency-Key": options.idempotencyKey }
          : {}),
      },
      method: "POST",
    });
  }

  async listPaymentRequests(options: {
    cursor?: string;
    limit?: number;
    status?: RelayPaymentStatus;
  } = {}): Promise<RelayPaymentRequestList> {
    const query = new URLSearchParams();
    if (options.cursor) query.set("cursor", options.cursor);
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    if (options.status) query.set("status", options.status);
    const suffix = query.size ? `?${query.toString()}` : "";
    return this.request<RelayPaymentRequestList>(
      `/v1/payment_requests${suffix}`,
      { method: "GET" },
    );
  }

  async getPaymentRequest(paymentRequestId: string): Promise<RelayPaymentRequest> {
    assertRelayUuid(paymentRequestId, "paymentRequestId");
    return this.request<RelayPaymentRequest>(
      `/v1/payment_requests/${encodeURIComponent(paymentRequestId)}`,
      { method: "GET" },
    );
  }

  /** Cancel a request that has not been paid; the card changes in place. */
  async cancelPaymentRequest(paymentRequestId: string): Promise<RelayPaymentRequest> {
    assertRelayUuid(paymentRequestId, "paymentRequestId");
    return this.request<RelayPaymentRequest>(
      `/v1/payment_requests/${encodeURIComponent(paymentRequestId)}/cancel`,
      {
        body: "{}",
        headers: { "Content-Type": "application/json" },
        method: "POST",
      },
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
    return this.request<RelayLocationRequestResponse>(
      `/v1/chats/${encodeURIComponent(chatId)}/location/request`,
      { method: "POST" },
    );
  }

  /**
   * Read where everyone sharing with the agent in this chat is now: one
   * GeoJSON Feature per person, coordinates `[longitude, latitude]`.
   * `data.features` is empty when nobody shares.
   */
  async getLocation(chatId: string): Promise<RelayChatLocation> {
    assertRelayUuid(chatId, "chatId");
    return this.request<RelayChatLocation>(
      `/v1/chats/${encodeURIComponent(chatId)}/location`,
      { method: "GET" },
    );
  }

  async setTyping(chatId: string, active: boolean): Promise<void> {
    assertRelayUuid(chatId, "chatId");
    await this.request<void>(
      `/v1/chats/${encodeURIComponent(chatId)}/typing`,
      { method: active ? "POST" : "DELETE" },
      { retryable: true },
    );
  }

  async markChatRead(
    chatId: string,
    options?: { maxRetries?: number },
  ): Promise<void> {
    assertRelayUuid(chatId, "chatId");
    await this.request<void>(
      `/v1/chats/${encodeURIComponent(chatId)}/read`,
      { method: "POST" },
      {
        retryable: true,
        ...(options?.maxRetries !== undefined
          ? { maxRetries: options.maxRetries }
          : {}),
      },
    );
  }

  async getChat(chatId: string): Promise<RelayChat> {
    assertRelayUuid(chatId, "chatId");
    return this.request<RelayChat>(
      `/v1/chats/${encodeURIComponent(chatId)}`,
      { method: "GET" },
    );
  }

  async getMessages(options: {
    chatId: string;
    cursor?: string;
    limit?: number;
  }): Promise<RelayGetMessagesResult> {
    assertRelayUuid(options.chatId, "chatId");
    const query = new URLSearchParams();
    if (options.cursor) query.set("cursor", options.cursor);
    if (options.limit !== undefined) {
      const limit = Math.trunc(options.limit);
      if (limit < 1 || limit > 100) {
        throw new ValidationError(
          "relay",
          "Relay message history limit must be between 1 and 100",
        );
      }
      query.set("limit", String(limit));
    }
    const suffix = query.size ? `?${query.toString()}` : "";
    return this.request<RelayGetMessagesResult>(
      `/v1/chats/${encodeURIComponent(options.chatId)}/messages${suffix}`,
      { method: "GET" },
    );
  }

  async getMessage(messageId: string): Promise<RelayMessage> {
    assertRelayUuid(messageId, "messageId");
    return this.request<RelayMessage>(
      `/v1/messages/${encodeURIComponent(messageId)}`,
      { method: "GET" },
    );
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
    return this.request<RelayAttachment>(
      `/v1/attachments/${encodeURIComponent(attachmentId)}`,
      { method: "GET" },
    );
  }

  async allocateAttachment(
    options: Omit<RelayUploadOptions, "body"> & { sizeBytes: number },
  ): Promise<RelayAttachmentAllocation> {
    return this.request<RelayAttachmentAllocation>("/v1/attachments", {
      body: JSON.stringify({
        filename: options.filename,
        content_type: options.contentType,
        size_bytes: options.sizeBytes,
        ...(options.durationMs !== undefined
          ? { duration_ms: options.durationMs }
          : {}),
        ...(options.width !== undefined &&
        options.height !== undefined
          ? { width: options.width, height: options.height }
          : {}),
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
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
    const allocation = await this.allocateAttachment({
      contentType: options.contentType,
      ...(options.durationMs !== undefined
        ? { durationMs: options.durationMs }
        : {}),
      filename: options.filename,
      ...(options.height !== undefined ? { height: options.height } : {}),
      sizeBytes: options.body.byteLength,
      ...(options.width !== undefined ? { width: options.width } : {}),
    });

    const uploadMethod = allocation.http_method.toUpperCase();
    const mayRetry = uploadMethod === "PUT";
    for (let attempt = 0; ; attempt += 1) {
      const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
      let response: Response;
      try {
        response = await this.fetchImpl(allocation.upload_url, {
          body: options.body,
          headers: allocation.required_headers,
          method: allocation.http_method,
          signal: timeoutSignal,
        });
      } catch (error) {
        if (mayRetry && attempt < this.maxRetries) {
          await delay(this.retryBaseDelayMs * 2 ** attempt);
          continue;
        }
        throw new NetworkError(
          "relay",
          timeoutSignal.aborted
            ? `Relay attachment upload timed out after ${this.timeoutMs}ms`
            : "Network error uploading bytes to Relay attachment storage",
          error instanceof Error ? error : undefined,
        );
      }
      if (response.ok) return allocation;
      const body = await parseResponseBody(response);
      const retryAfter = retryAfterSeconds(
        body,
        response.headers.get("retry-after"),
      );
      if (mayRetry && isRetryableStatus(response.status) && attempt < this.maxRetries) {
        await delay(retryWaitMs(retryAfter, this.retryBaseDelayMs, attempt));
        continue;
      }
      const details = errorDetails(body, response.status);
      throw new RelayApiError(
        response.status,
        details.code,
        details.message,
        body,
      );
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
