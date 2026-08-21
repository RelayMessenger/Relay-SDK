import {
  RelayApiError,
  classifyRelayHttpStatus,
  isAbortError,
} from "./errors.js";
import type {
  RelayAgentProfile,
  RelayEventsPage,
  RelayOutgoingPart,
  RelayReplyRef,
  RelaySendResult,
} from "./types.js";
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
  pollEvents: (params: {
    cursor: number;
    timeoutSeconds?: number;
    limit?: number;
    signal?: AbortSignal;
  }) => Promise<RelayEventsPage>;
  sendMessage: (params: {
    conversationId: string;
    parts: RelayOutgoingPart[];
    replyTo?: RelayReplyRef;
    invocationId?: string;
    idempotencyKey: string;
    signal?: AbortSignal;
  }) => Promise<RelaySendResult>;
  sendText: (params: {
    conversationId: string;
    text: string;
    replyTo?: RelayReplyRef;
    invocationId?: string;
    idempotencyKey: string;
    signal?: AbortSignal;
  }) => Promise<RelaySendResult>;
  setTyping: (params: {
    conversationId: string;
    started: boolean;
    label?: string;
    invocationId?: string;
    signal?: AbortSignal;
  }) => Promise<void>;
  setResponding: (params: {
    conversationId: string;
    messageId: string;
    label?: string;
    invocationId?: string;
    signal?: AbortSignal;
  }) => Promise<void>;
  /**
   * Advance the delivered watermark to `messageId`, and every earlier message
   * from other participants with it.
   *
   * Send this when the message reaches the agent, before anything that implies
   * a read. The server advances the delivered watermark whenever it records a
   * read, so a delivered receipt that arrives after a read for the same
   * message is silently dropped and the sender never leaves "Sent".
   */
  markDelivered: (params: {
    conversationId: string;
    messageId: string;
    signal?: AbortSignal;
  }) => Promise<void>;
  markRead: (params: {
    conversationId: string;
    messageId: string;
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
    throw new Error("relay: Agent Token is required");
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
        ...(params.body === undefined ? {} : { body: JSON.stringify(params.body) }),
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
      const timeoutSeconds = Math.min(Math.max(params.timeoutSeconds ?? 30, 1), 30);
      const response = await request({
        method: "GET",
        path: "/v1/events",
        query: {
          cursor: params.cursor,
          timeout: timeoutSeconds,
          ...(params.limit === undefined ? {} : { limit: params.limit }),
        },
        ...(params.signal ? { signal: params.signal } : {}),
        timeoutMs: (timeoutSeconds + 15) * 1_000,
      });
      const body = (await response.json()) as {
        events?: RelayEventsPage["events"];
        next_cursor?: number;
      };
      const events = Array.isArray(body.events) ? body.events : [];
      const nextCursor =
        typeof body.next_cursor === "number" && Number.isSafeInteger(body.next_cursor)
          ? body.next_cursor
          : params.cursor;
      return { events, nextCursor };
    },

    sendMessage: async (params) => {
      const response = await request({
        method: "POST",
        path: "/v1/messages",
        headers: { "idempotency-key": params.idempotencyKey },
        body: {
          conversation_id: params.conversationId,
          parts: params.parts,
          ...(params.invocationId ? { invocation_id: params.invocationId } : {}),
          ...(params.replyTo ? { reply_to: params.replyTo } : {}),
        },
        ...(params.signal ? { signal: params.signal } : {}),
      });
      const body = (await response.json()) as {
        messages: RelaySendResult["messages"];
      };
      return { messages: body.messages };
    },

    sendText: async (params) => {
      const { text, ...rest } = params;
      return client.sendMessage({
        ...rest,
        parts: [{ type: "text", text }],
      });
    },

    setTyping: async (params) => {
      await request({
        method: "POST",
        path: `/v1/conversations/${encodeURIComponent(params.conversationId)}/typing`,
        body: {
          started: params.started,
          ...(params.label ? { label: params.label } : {}),
          ...(params.invocationId ? { invocation_id: params.invocationId } : {}),
        },
        ...(params.signal ? { signal: params.signal } : {}),
      });
    },

    setResponding: async (params) => {
      await request({
        method: "POST",
        path: `/v1/conversations/${encodeURIComponent(params.conversationId)}/responding`,
        body: {
          message_id: params.messageId,
          ...(params.label ? { label: params.label } : {}),
          ...(params.invocationId ? { invocation_id: params.invocationId } : {}),
        },
        ...(params.signal ? { signal: params.signal } : {}),
      });
    },

    markDelivered: async (params) => {
      await request({
        method: "POST",
        path: `/v1/conversations/${encodeURIComponent(params.conversationId)}/delivered`,
        body: { message_id: params.messageId },
        ...(params.signal ? { signal: params.signal } : {}),
      });
    },

    markRead: async (params) => {
      await request({
        method: "POST",
        path: `/v1/conversations/${encodeURIComponent(params.conversationId)}/read`,
        body: { message_id: params.messageId },
        ...(params.signal ? { signal: params.signal } : {}),
      });
    },
  };

  return client;
}
