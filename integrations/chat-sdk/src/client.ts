import type {
  RelayAttachment,
  RelayConversation,
  RelayMessage,
  RelayOutgoingPart,
  RelayReactionType,
  RelaySendResult,
  RelayUserProfile,
} from "./types.js";

export interface RelayClientOptions {
  /** Agent Token (`rly_live_...`). */
  token: string;
  /** Defaults to Relay production. */
  baseUrl?: string;
  fetch?: typeof fetch;
}

export interface RelaySendOptions {
  conversationId: string;
  parts: RelayOutgoingPart[];
  idempotencyKey: string;
  invocationId?: string;
  replyTo?: { messageId: string; partIndex?: number };
}

export interface RelayReactionOptions {
  messageId: string;
  operation: "add" | "remove";
  type: RelayReactionType;
  emoji?: string;
  partIndex?: number;
}

export interface RelayHistoryOptions {
  conversationId: string;
  limit?: number;
  beforeSequence?: number;
}

export interface RelayUploadOptions {
  body: Uint8Array;
  contentType?: string;
  filename?: string;
}

export class RelayApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RelayApiError";
  }
}

const DEFAULT_BASE_URL = "https://api.relayapp.im";

async function raiseForStatus(response: Response): Promise<void> {
  if (response.ok) return;
  let code = "unknown";
  let message = `${response.status}`;
  try {
    const body = (await response.json()) as {
      error?: { code?: string; message?: string };
    };
    code = body.error?.code ?? code;
    message = body.error?.message ?? message;
  } catch {
    // non-JSON error body; keep the status text
  }
  throw new RelayApiError(response.status, code, message);
}

/**
 * Minimal Relay v1 client covering exactly what the Chat SDK adapter calls.
 * Raw HTTPS remains the canonical contract; see
 * https://docs.relayapp.im/api-reference/overview.
 */
export class RelayClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: RelayClientOptions) {
    if (!options.token) throw new Error("Relay Agent Token is required");
    this.token = options.token;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.fetchImpl = options.fetch ?? fetch;
  }

  private authHeaders(extra?: Record<string, string>): Record<string, string> {
    return { Authorization: `Bearer ${this.token}`, ...extra };
  }

  private async json<T>(
    path: string,
    init: RequestInit & { headers?: Record<string, string> },
  ): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: this.authHeaders(init.headers),
    });
    await raiseForStatus(response);
    return (await response.json()) as T;
  }

  /** `POST /v1/messages`. The idempotency key is mandatory on this route. */
  async send(options: RelaySendOptions): Promise<RelaySendResult> {
    return this.json<RelaySendResult>("/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": options.idempotencyKey,
      },
      body: JSON.stringify({
        conversation_id: options.conversationId,
        parts: options.parts,
        ...(options.invocationId ? { invocation_id: options.invocationId } : {}),
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
      }),
    });
  }

  /**
   * `PATCH /v1/messages/{id}`. Relay allows edits for 15 minutes and at most
   * five revisions, and rejects any part that is not text-bearing.
   */
  async edit(
    messageId: string,
    parts: RelayOutgoingPart[],
  ): Promise<{ message: RelayMessage }> {
    return this.json<{ message: RelayMessage }>(
      `/v1/messages/${encodeURIComponent(messageId)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parts }),
      },
    );
  }

  /** `DELETE /v1/messages/{id}`. Relay allows unsend for two minutes. */
  async unsend(messageId: string): Promise<{ message: RelayMessage }> {
    return this.json<{ message: RelayMessage }>(
      `/v1/messages/${encodeURIComponent(messageId)}`,
      { method: "DELETE" },
    );
  }

  /** `POST /v1/messages/{id}/reactions`. One route adds and removes. */
  async react(options: RelayReactionOptions): Promise<void> {
    const response = await this.fetchImpl(
      `${this.baseUrl}/v1/messages/${encodeURIComponent(options.messageId)}/reactions`,
      {
        method: "POST",
        headers: this.authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          operation: options.operation,
          type: options.type,
          ...(options.emoji ? { emoji: options.emoji } : {}),
          ...(options.partIndex !== undefined
            ? { part_index: options.partIndex }
            : {}),
        }),
      },
    );
    await raiseForStatus(response);
  }

  /**
   * `POST /v1/conversations/{id}/typing`. Ephemeral: pushed to live devices,
   * never entering the event log. Relay also exposes `/responding`, which
   * commits a Read receipt before it starts typing; this adapter keeps the two
   * apart so `markAsRead` stays the only call that moves a watermark.
   */
  async typing(options: {
    conversationId: string;
    started?: boolean;
    label?: string;
    invocationId?: string;
  }): Promise<void> {
    const response = await this.fetchImpl(
      `${this.baseUrl}/v1/conversations/${encodeURIComponent(options.conversationId)}/typing`,
      {
        method: "POST",
        headers: this.authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          started: options.started ?? true,
          ...(options.label ? { label: options.label } : {}),
          ...(options.invocationId
            ? { invocation_id: options.invocationId }
            : {}),
        }),
      },
    );
    await raiseForStatus(response);
  }

  /**
   * `POST /v1/conversations/{id}/read`. Watermark semantics: everything
   * through `messageId` is read. Older or repeated targets are no-ops.
   */
  async markRead(conversationId: string, messageId: string): Promise<void> {
    const response = await this.fetchImpl(
      `${this.baseUrl}/v1/conversations/${encodeURIComponent(conversationId)}/read`,
      {
        method: "POST",
        headers: this.authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ message_id: messageId }),
      },
    );
    await raiseForStatus(response);
  }

  /** `GET /v1/conversations/{id}/messages`, newest first. */
  async history(options: RelayHistoryOptions): Promise<{ messages: RelayMessage[] }> {
    const query = new URLSearchParams();
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    if (options.beforeSequence !== undefined) {
      query.set("before_sequence", String(options.beforeSequence));
    }
    const suffix = query.size > 0 ? `?${query}` : "";
    return this.json<{ messages: RelayMessage[] }>(
      `/v1/conversations/${encodeURIComponent(options.conversationId)}/messages${suffix}`,
      { method: "GET" },
    );
  }

  /** `GET /v1/conversations/{id}`. */
  async conversation(
    conversationId: string,
  ): Promise<{ conversation: RelayConversation }> {
    return this.json<{ conversation: RelayConversation }>(
      `/v1/conversations/${encodeURIComponent(conversationId)}`,
      { method: "GET" },
    );
  }

  /**
   * `GET /v1/users/{id}`. Scoped: the user must currently share an active
   * conversation with this agent, so an unknown id answers 404 rather than
   * confirming that an account exists.
   */
  async user(userId: string): Promise<{ user: RelayUserProfile }> {
    return this.json<{ user: RelayUserProfile }>(
      `/v1/users/${encodeURIComponent(userId)}`,
      { method: "GET" },
    );
  }

  /**
   * `POST /v1/attachments`. One raw body, `Content-Length` required and
   * verified against the stored object. Used for Chat SDK file uploads and for
   * attachments that arrive as bytes rather than a public URL.
   */
  async upload(options: RelayUploadOptions): Promise<RelayAttachment> {
    const headers: Record<string, string> = {
      "Content-Length": String(options.body.byteLength),
      "Content-Type": options.contentType ?? "application/octet-stream",
    };
    if (options.filename) headers["X-Relay-Filename"] = options.filename;
    const body = options.body.slice().buffer;
    const result = await this.json<{ attachment: RelayAttachment }>(
      "/v1/attachments",
      { method: "POST", headers, body },
    );
    return result.attachment;
  }
}
