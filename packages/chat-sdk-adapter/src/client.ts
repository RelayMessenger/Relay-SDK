import {
  AdapterError,
  NetworkError,
  ValidationError,
} from "@chat-adapter/shared";
import type { RelayCredential } from "./credentials.js";
import {
  resolveRelayCredential,
  validateStaticCredential,
} from "./credentials.js";
import { assertRelayUuid } from "./thread-id.js";
import type {
  RelayAttachmentAllocation,
  RelayChat,
  RelayGetMessagesResult,
  RelayMessage,
  RelayOutgoingPart,
  RelayReactionType,
  RelaySendMessageResponse,
} from "./types.js";

export const RELAY_DEFAULT_BASE_URL = "https://api.relayapp.im";

export interface RelayClientOptions {
  /** Relay Agent Token or a resolver evaluated for every Relay API call. */
  token?: RelayCredential;
  baseUrl?: string;
  fetch?: typeof fetch;
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
 * Minimal client for only the locked Relay v1 operations used by the adapter.
 */
export class RelayClient {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly token: RelayCredential | undefined;

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
  }

  private async request<T>(
    path: string,
    init: RequestInit,
  ): Promise<T> {
    const token = await resolveRelayCredential(
      this.token,
      "Relay Agent Token",
    );
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          ...Object.fromEntries(new Headers(init.headers).entries()),
        },
      });
    } catch (error) {
      throw new NetworkError(
        "relay",
        "Network error calling the Relay API",
        error instanceof Error ? error : undefined,
      );
    }
    const body = await parseResponseBody(response);
    if (!response.ok) {
      const details = errorDetails(body, response.status);
      throw new RelayApiError(
        response.status,
        details.code,
        details.message,
        body,
      );
    }
    return body as T;
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

  async setTyping(chatId: string, active: boolean): Promise<void> {
    assertRelayUuid(chatId, "chatId");
    await this.request<void>(
      `/v1/chats/${encodeURIComponent(chatId)}/typing`,
      { method: active ? "POST" : "DELETE" },
    );
  }

  async markChatRead(chatId: string): Promise<void> {
    assertRelayUuid(chatId, "chatId");
    await this.request<void>(
      `/v1/chats/${encodeURIComponent(chatId)}/read`,
      { method: "POST" },
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

    let response: Response;
    try {
      response = await this.fetchImpl(allocation.upload_url, {
        body: options.body,
        headers: allocation.required_headers,
        method: allocation.http_method,
      });
    } catch (error) {
      throw new NetworkError(
        "relay",
        "Network error uploading bytes to Relay attachment storage",
        error instanceof Error ? error : undefined,
      );
    }
    if (!response.ok) {
      const body = await parseResponseBody(response);
      const details = errorDetails(body, response.status);
      throw new RelayApiError(
        response.status,
        details.code,
        details.message,
        body,
      );
    }
    return allocation;
  }

  /**
   * Download the bytes of an inbound Relay media part.
   *
   * A Relay media URL is a sealed download capability: the transfer route is
   * unauthenticated, so no Agent Token is sent, and the capability expires 15
   * minutes after Relay minted it. A download after that window fails with
   * HTTP 404, and Relay exposes no agent-facing route that re-mints a URL from
   * an attachment id.
   */
  async downloadAttachment(options: {
    attachmentId?: string;
    url: string;
  }): Promise<ArrayBuffer> {
    const label = options.attachmentId ?? options.url;
    let response: Response;
    try {
      response = await this.fetchImpl(options.url);
    } catch (error) {
      throw new NetworkError(
        "relay",
        `Network error downloading Relay attachment ${label}`,
        error instanceof Error ? error : undefined,
      );
    }
    if (!response.ok) {
      const body = await parseResponseBody(response);
      const details = errorDetails(body, response.status);
      throw new RelayApiError(
        response.status,
        details.code,
        `Failed to download Relay attachment ${label}: `
          + `HTTP ${response.status}`,
        body,
      );
    }
    return await response.arrayBuffer();
  }
}
