// Thin Relay REST client for the OpenClaw channel plugin. Bespoke fetch until
// the Relay SDK ships (doc 03 §1). Owns the abort-aware long poll, idempotent
// sends, typing, and read watermarks. No SDK imports so unit tests run
// without an OpenClaw runtime.
import type {
  RelayAgentProfile,
  RelayEventsPage,
  RelayPart,
  RelayReplyRef,
  RelaySendResult,
} from "./types.js";

export const DEFAULT_RELAY_BASE_URL = "https://api.relayapp.im";

export type RelayApiErrorKind = "auth" | "conflict" | "retryable" | "rejected";

/** Classified Relay API failure. `terminal` means operator action (bad token). */
export class RelayApiError extends Error {
  readonly status: number | undefined;
  readonly kind: RelayApiErrorKind;
  /** Server error code from the response body (`error.code`), when present. */
  readonly code: string | undefined;

  constructor(
    message: string,
    params: { status?: number; kind: RelayApiErrorKind; code?: string },
  ) {
    super(message);
    this.name = "RelayApiError";
    this.status = params.status;
    this.kind = params.kind;
    this.code = params.code;
  }

  get terminal(): boolean {
    return this.kind === "auth";
  }

  get retryable(): boolean {
    return this.kind === "retryable";
  }
}

/**
 * 409 from the webhook XOR rule: an enabled webhook endpoint makes long
 * polling unavailable until the operator disables it (server code
 * `conflict`, distinct from `terminated_by_other_consumer`).
 */
export function isRelayWebhookConflict(error: unknown): error is RelayApiError {
  return (
    error instanceof RelayApiError &&
    error.status === 409 &&
    error.code !== "terminated_by_other_consumer"
  );
}

export function classifyRelayHttpStatus(status: number): RelayApiErrorKind {
  if (status === 401) {
    return "auth";
  }
  if (status === 409) {
    return "conflict";
  }
  if (status === 408 || status === 429 || status >= 500) {
    return "retryable";
  }
  return "rejected";
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type RelayClientOptions = {
  baseUrl?: string;
  token: string;
  fetchImpl?: FetchLike;
};

export type RelayClient = {
  getMe: (params?: { signal?: AbortSignal }) => Promise<RelayAgentProfile>;
  pollEvents: (params: {
    cursor: number;
    timeoutSeconds?: number;
    limit?: number;
    signal?: AbortSignal;
  }) => Promise<RelayEventsPage>;
  sendMessage: (params: {
    conversationId: string;
    parts: Array<Pick<RelayPart, never> & Record<string, unknown>>;
    replyTo?: RelayReplyRef;
    idempotencyKey: string;
    signal?: AbortSignal;
  }) => Promise<RelaySendResult>;
  setTyping: (params: {
    conversationId: string;
    started: boolean;
    label?: string;
    signal?: AbortSignal;
  }) => Promise<void>;
  markRead: (params: {
    conversationId: string;
    messageId: string;
    signal?: AbortSignal;
  }) => Promise<void>;
};

async function readErrorDetail(
  response: Response,
): Promise<{ code?: string; message: string }> {
  try {
    const body = (await response.json()) as {
      error?: { code?: string; message?: string };
      message?: string;
    };
    return {
      ...(body?.error?.code ? { code: body.error.code } : {}),
      message: body?.error?.message ?? body?.message ?? "",
    };
  } catch {
    return { message: "" };
  }
}

export function createRelayClient(options: RelayClientOptions): RelayClient {
  const baseUrl = (options.baseUrl?.trim() || DEFAULT_RELAY_BASE_URL).replace(/\/+$/, "");
  const fetchImpl: FetchLike = options.fetchImpl ?? ((input, init) => fetch(input, init));

  const request = async (params: {
    method: string;
    path: string;
    query?: Record<string, string | number | boolean | undefined>;
    body?: unknown;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  }): Promise<Response> => {
    const url = new URL(`${baseUrl}${params.path}`);
    for (const [key, value] of Object.entries(params.query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
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
        ...(params.signal ? { signal: params.signal } : {}),
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      // Network-level failure (DNS, reset, offline): always retryable.
      throw new RelayApiError(`relay: network error: ${String(error)}`, { kind: "retryable" });
    }
    if (!response.ok) {
      const detail = await readErrorDetail(response);
      throw new RelayApiError(
        `relay: ${params.method} ${params.path} failed with ${response.status}${detail.message ? `: ${detail.message}` : ""}`,
        {
          status: response.status,
          kind: classifyRelayHttpStatus(response.status),
          ...(detail.code ? { code: detail.code } : {}),
        },
      );
    }
    return response;
  };

  return {
    getMe: async (params) => {
      const response = await request({
        method: "GET",
        path: "/v1/agents/me",
        signal: params?.signal,
      });
      const body = (await response.json()) as { agent: RelayAgentProfile };
      return body.agent;
    },

    pollEvents: async (params) => {
      const timeoutSeconds = Math.min(Math.max(params.timeoutSeconds ?? 30, 1), 30);
      // Guard against a wedged connection: the server holds <= timeout seconds,
      // so anything past timeout + slack is a dead socket, not a slow poll.
      const guards = [AbortSignal.timeout((timeoutSeconds + 15) * 1_000)];
      if (params.signal) {
        guards.push(params.signal);
      }
      const response = await request({
        method: "GET",
        path: "/v1/events",
        query: {
          cursor: params.cursor,
          timeout: timeoutSeconds,
          ...(params.limit === undefined ? {} : { limit: params.limit }),
        },
        signal: AbortSignal.any(guards),
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
          ...(params.replyTo ? { reply_to: params.replyTo } : {}),
        },
        signal: params.signal,
      });
      const body = (await response.json()) as {
        message_id: string;
        message: RelaySendResult["message"];
      };
      return { messageId: body.message_id, message: body.message };
    },

    setTyping: async (params) => {
      await request({
        method: "POST",
        path: `/v1/conversations/${encodeURIComponent(params.conversationId)}/typing`,
        body: {
          started: params.started,
          ...(params.label ? { label: params.label } : {}),
        },
        signal: params.signal,
      });
    },

    markRead: async (params) => {
      await request({
        method: "POST",
        path: `/v1/conversations/${encodeURIComponent(params.conversationId)}/read`,
        body: { message_id: params.messageId },
        signal: params.signal,
      });
    },
  };
}
