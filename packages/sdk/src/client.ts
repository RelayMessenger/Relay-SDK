import {
  RelayApiError,
  classifyRelayHttpStatus,
  isAbortError,
} from "./errors.js";
import type {
  RelayAgentProfile,
  RelayAttachment,
  RelayEventsPage,
  RelayHistoryPage,
  RelayId,
  RelayMessage,
  RelayOutgoingPart,
  RelayReactionResult,
  RelayReceipt,
  RelayReplyTarget,
  RelaySendResult,
} from "./types.js";
import { relayId } from "./ulid.js";
import { normalizeRelayBaseUrl } from "./url.js";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type RelayClientOptions = {
  token: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
  requestTimeoutMs?: number;
};

export type RelayClient = {
  readonly baseUrl: string;
  getMe: (params?: { signal?: AbortSignal }) => Promise<RelayAgentProfile>;
  /**
   * One page of this agent's durable event log.
   *
   * `after` is the last sequence you have seen and the page is everything
   * newer, oldest first. There is no exclusive consumer, no acknowledgement
   * handshake and no reconcile step: persist `nextCursor` once you have
   * durably handled the page, and ignore an event you have already seen —
   * delivery is at least once. `timeoutSeconds` from 1 to 30 holds the
   * request open until something arrives.
   */
  pollEvents: (params: {
    after: number;
    timeoutSeconds?: number;
    limit?: number;
    signal?: AbortSignal;
  }) => Promise<RelayEventsPage>;
  /**
   * `/v1` send. One send is one message; the array in the response body
   * always has exactly one element. Kept for clients already shipped against
   * it — new code should use `sendMessage`.
   */
  sendMessageV1: (params: {
    conversationId: string;
    messageId?: RelayId;
    parts: RelayOutgoingPart[];
    replyTo?: RelayReplyTarget;
    fallbackText?: string;
    signal?: AbortSignal;
  }) => Promise<RelaySendResult>;
  /**
   * `/v2` send: one send is one message. Mints a `msg_` ULID when
   * `messageId` is absent, and that id is the message's identity AND the only
   * retry key — no `Idempotency-Key` header is involved.
   *
   * Mint the id once per logical send and reuse it across retries. Minting a
   * fresh one on retry is how you send the same message twice.
   */
  sendMessage: (params: {
    conversationId: string;
    messageId?: RelayId;
    parts: RelayOutgoingPart[];
    replyTo?: RelayReplyTarget;
    fallbackText?: string;
    signal?: AbortSignal;
  }) => Promise<RelaySendResult>;
  sendText: (params: {
    conversationId: string;
    messageId?: RelayId;
    text: string;
    replyTo?: RelayReplyTarget;
    signal?: AbortSignal;
  }) => Promise<RelaySendResult>;
  /** Upload bytes and get an `att_` id to reference from a media part. */
  uploadAttachment: (params: {
    body: Uint8Array | ArrayBuffer;
    contentType: string;
    filename?: string;
    signal?: AbortSignal;
  }) => Promise<RelayAttachment>;
  /**
   * Add, change or remove a reaction. Pass `targetPartId` to react to one
   * exact part; omit it for the whole message. Changing an emoji is an `add`
   * on the slot the previous one occupied, and repeating a request changes
   * nothing the second time — there is no operation id.
   */
  react: (params: {
    messageId: RelayId;
    operation: "add" | "remove";
    emoji: string;
    targetPartId?: RelayId;
    signal?: AbortSignal;
  }) => Promise<RelayReactionResult>;
  /** A page of conversation history, newest first. */
  getHistory: (params: {
    conversationId: string;
    limit?: number;
    beforeSequence?: number;
    signal?: AbortSignal;
  }) => Promise<RelayHistoryPage>;
  /**
   * Advance the delivered watermark to `messageId`, and every earlier message
   * from other participants with it.
   *
   * Most agents never call this. Delivered means the agent's endpoint has the
   * message, so Relay records it from the transport itself: a webhook gets it
   * when the endpoint answers `2xx`, and a `GET /v1/events` consumer gets it
   * when Relay hands the page over. Neither needs a line of code.
   *
   * The exception is a transcript poller — a client that reads
   * `GET /v1/conversations/:id/messages` on a timer. Reading history records
   * no receipt, so nothing on the server ever learns the message arrived.
   * That client, and only that client, has to say so itself.
   */
  markDelivered: (params: {
    conversationId: string;
    messageId: RelayId;
    signal?: AbortSignal;
  }) => Promise<RelayReceipt>;
  markRead: (params: {
    conversationId: string;
    messageId: RelayId;
    signal?: AbortSignal;
  }) => Promise<RelayReceipt>;
  /**
   * Ephemeral typing. Fire and forget: nothing is stored, no lease is taken,
   * and the recipient's client hides the indicator on its own after 90
   * seconds. Send the start again while still composing to keep it alive.
   */
  setTyping: (params: {
    conversationId: string;
    started: boolean;
    signal?: AbortSignal;
  }) => Promise<void>;
};

async function readErrorDetail(response: Response): Promise<{
  code?: string;
  message: string;
  details?: Record<string, unknown>;
}> {
  try {
    const body = (await response.json()) as {
      error?: { code?: string; message?: string; details?: Record<string, unknown> };
      message?: string;
    };
    return {
      ...(body?.error?.code ? { code: body.error.code } : {}),
      ...(body?.error?.details ? { details: body.error.details } : {}),
      message: body?.error?.message ?? body?.message ?? "",
    };
  } catch {
    return { message: "" };
  }
}

export function createRelayClient(options: RelayClientOptions): RelayClient {
  if (!options.token.trim()) {
    throw new Error("relay: API key is required");
  }
  const baseUrl = normalizeRelayBaseUrl(options.baseUrl);
  const fetchImpl: FetchLike =
    options.fetchImpl ?? ((input, init) => fetch(input, init));
  const requestTimeoutMs = options.requestTimeoutMs ?? 15_000;

  const request = async (params: {
    method: string;
    path: string;
    query?: Record<string, string | number | boolean | undefined>;
    body?: unknown;
    /** Pre-encoded bytes, for the routes that take an octet-stream. */
    rawBody?: Uint8Array;
    headers?: Record<string, string>;
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<Response> => {
    const url = new URL(`${baseUrl}${params.path}`);
    for (const [key, value] of Object.entries(params.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const timeoutSignal = AbortSignal.timeout(params.timeoutMs ?? requestTimeoutMs);
    const signal = params.signal
      ? AbortSignal.any([params.signal, timeoutSignal])
      : timeoutSignal;
    let response: Response;
    try {
      response = await fetchImpl(url.toString(), {
        method: params.method,
        headers: {
          authorization: `Bearer ${options.token}`,
          ...(params.body === undefined ? {} : { "content-type": "application/json" }),
          ...params.headers,
        },
        ...(params.rawBody === undefined
          ? params.body === undefined
            ? {}
            : { body: JSON.stringify(params.body) }
          : { body: params.rawBody as unknown as BodyInit }),
        signal,
      });
    } catch (error) {
      if (timeoutSignal.aborted && !params.signal?.aborted) {
        throw new RelayApiError(
          `relay: ${params.method} ${params.path} timed out after ${params.timeoutMs ?? requestTimeoutMs}ms`,
          { kind: "retryable" },
        );
      }
      if (isAbortError(error)) throw error;
      throw new RelayApiError(`relay: network error: ${String(error)}`, {
        kind: "retryable",
      });
    }
    if (!response.ok) {
      const detail = await readErrorDetail(response);
      throw new RelayApiError(
        `relay: ${params.method} ${params.path} failed with ${response.status}${detail.message ? `: ${detail.message}` : ""}`,
        {
          status: response.status,
          kind: classifyRelayHttpStatus(response.status),
          ...(detail.code ? { code: detail.code } : {}),
          ...(detail.details ? { details: detail.details } : {}),
        },
      );
    }
    return response;
  };

  const sendBody = (params: {
    messageId: RelayId;
    parts: RelayOutgoingPart[];
    replyTo?: RelayReplyTarget;
    fallbackText?: string;
  }) => ({
    message_id: params.messageId,
    parts: params.parts,
    ...(params.replyTo ? { reply_to: params.replyTo } : {}),
    ...(params.fallbackText === undefined ? {} : { fallback_text: params.fallbackText }),
  });

  const receipt = async (
    kind: "read" | "delivered",
    params: { conversationId: string; messageId: RelayId; signal?: AbortSignal },
  ): Promise<RelayReceipt> => {
    const response = await request({
      method: "POST",
      path: `/v1/conversations/${encodeURIComponent(params.conversationId)}/${kind}`,
      body: { message_id: params.messageId },
      ...(params.signal ? { signal: params.signal } : {}),
    });
    const body = (await response.json()) as { receipt?: RelayReceipt };
    if (!body.receipt) {
      throw new RelayApiError(`relay: ${kind} receipt returned no watermark`, {
        status: response.status,
        kind: "retryable",
      });
    }
    return body.receipt;
  };


  const client: RelayClient = {
    baseUrl,

    getMe: async (params) => {
      const response = await request({
        method: "GET",
        path: "/v1/agents/me",
        ...(params?.signal ? { signal: params.signal } : {}),
      });
      const body = (await response.json()) as { agent: RelayAgentProfile };
      return body.agent;
    },

    pollEvents: async (params) => {
      const timeoutSeconds = Math.min(Math.max(params.timeoutSeconds ?? 30, 0), 30);
      const response = await request({
        method: "GET",
        path: "/v1/events",
        query: {
          after: params.after,
          timeout: timeoutSeconds,
          ...(params.limit === undefined ? {} : { limit: params.limit }),
        },
        ...(params.signal ? { signal: params.signal } : {}),
        timeoutMs: (timeoutSeconds + 15) * 1_000,
      });
      const body = (await response.json()) as {
        events?: RelayEventsPage["events"];
        next_cursor?: number;
        latest?: number;
        has_more?: boolean;
      };
      const events = Array.isArray(body.events) ? body.events : [];
      const nextCursor =
        typeof body.next_cursor === "number" && Number.isSafeInteger(body.next_cursor)
          ? body.next_cursor
          : params.after;
      const latest =
        typeof body.latest === "number" && Number.isSafeInteger(body.latest)
          ? body.latest
          : nextCursor;
      return { events, nextCursor, latest, hasMore: body.has_more === true };
    },

    sendMessageV1: async (params) => {
      const messageId = params.messageId ?? relayId("msg");
      const response = await request({
        method: "POST",
        path: `/v1/conversations/${encodeURIComponent(params.conversationId)}/messages`,
        body: sendBody({ ...params, messageId }),
        ...(params.signal ? { signal: params.signal } : {}),
      });
      // `/v1` answers `{ messages: [one] }`. One send is one message now, so
      // the array is a shape shipped clients still read, not a split.
      const body = (await response.json()) as { messages?: RelayMessage[] };
      const message = Array.isArray(body.messages) ? body.messages[0] : undefined;
      if (!message) {
        throw new RelayApiError("relay: send returned no committed message", {
          status: response.status,
          kind: "retryable",
        });
      }
      return { messageId, message };
    },

    sendMessage: async (params) => {
      const messageId = params.messageId ?? relayId("msg");
      const response = await request({
        method: "POST",
        path: `/v2/conversations/${encodeURIComponent(params.conversationId)}/messages`,
        body: sendBody({ ...params, messageId }),
        ...(params.signal ? { signal: params.signal } : {}),
      });
      const body = (await response.json()) as { message?: RelayMessage };
      if (!body.message) {
        throw new RelayApiError("relay: send returned no message", {
          status: response.status,
          kind: "retryable",
        });
      }
      return { messageId, message: body.message };
    },

    sendText: async (params) => {
      const { text, ...rest } = params;
      return client.sendMessage({ ...rest, parts: [{ type: "text", text }] });
    },

    uploadAttachment: async (params) => {
      const bytes = params.body instanceof Uint8Array
        ? params.body
        : new Uint8Array(params.body);
      const response = await request({
        method: "POST",
        path: "/v1/attachments",
        rawBody: bytes,
        headers: {
          "content-type": params.contentType,
          "content-length": String(bytes.byteLength),
          ...(params.filename ? { "x-relay-filename": params.filename } : {}),
        },
        ...(params.signal ? { signal: params.signal } : {}),
      });
      const body = (await response.json()) as { attachment?: RelayAttachment };
      if (!body.attachment) {
        throw new RelayApiError("relay: upload returned no attachment", {
          status: response.status,
          kind: "retryable",
        });
      }
      return body.attachment;
    },

    react: async (params) => {
      const response = await request({
        method: "POST",
        path: `/v1/messages/${encodeURIComponent(params.messageId)}/reactions`,
        body: {
          operation: params.operation,
          type: "emoji",
          emoji: params.emoji,
          ...(params.targetPartId ? { target_part_id: params.targetPartId } : {}),
        },
        ...(params.signal ? { signal: params.signal } : {}),
      });
      const body = (await response.json()) as { reaction?: RelayReactionResult };
      if (!body.reaction) {
        throw new RelayApiError("relay: reaction returned no result", {
          status: response.status,
          kind: "retryable",
        });
      }
      return body.reaction;
    },

    getHistory: async (params) => {
      const response = await request({
        method: "GET",
        path: `/v1/conversations/${encodeURIComponent(params.conversationId)}/messages`,
        query: {
          ...(params.limit === undefined ? {} : { limit: params.limit }),
          ...(params.beforeSequence === undefined
            ? {}
            : { before_sequence: params.beforeSequence }),
        },
        ...(params.signal ? { signal: params.signal } : {}),
      });
      const body = (await response.json()) as { messages?: RelayMessage[] };
      return { messages: Array.isArray(body.messages) ? body.messages : [] };
    },

    markDelivered: async (params) => receipt("delivered", params),
    markRead: async (params) => receipt("read", params),

    setTyping: async (params) => {
      await request({
        method: "POST",
        path: `/v1/conversations/${encodeURIComponent(params.conversationId)}/typing`,
        body: { started: params.started },
        ...(params.signal ? { signal: params.signal } : {}),
      });
    },
  };

  return client;
}
