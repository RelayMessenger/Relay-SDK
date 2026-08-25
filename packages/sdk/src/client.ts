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
  RelayPartOperation,
  RelayReactionResult,
  RelayEditRequest,
  RelayReconcileResult,
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
  pollEvents: (params: {
    cursor: number;
    timeoutSeconds?: number;
    limit?: number;
    signal?: AbortSignal;
  }) => Promise<RelayEventsPage>;
  /**
   * `/v1` send. Relay splits the parts at ingest, so this can commit several
   * messages; read `messages`. Kept for clients already shipped against it.
   */
  sendMessage: (params: {
    conversationId: string;
    parts: RelayOutgoingPart[];
    replyTo?: RelayReplyTarget;
    invocationId?: string;
    idempotencyKey: string;
    signal?: AbortSignal;
  }) => Promise<RelaySendResult>;
  /**
   * `/v2` send: one send is one message. Mints a `msg_` ULID when
   * `messageId` is absent, and that id is both the message's identity and the
   * retry key, so no `Idempotency-Key` is involved.
   *
   * Mint the id once per logical send and reuse it across retries. Minting a
   * fresh one on retry is how you send the same message twice.
   */
  sendMessageV2: (params: {
    conversationId: string;
    messageId?: RelayId;
    parts: RelayOutgoingPart[];
    replyTo?: RelayReplyTarget;
    invokedAgentIds?: RelayId[];
    fallbackText?: string;
    invocationId?: string;
    signal?: AbortSignal;
  }) => Promise<{ messageId: RelayId; message: RelayMessage }>;
  sendText: (params: {
    conversationId: string;
    text: string;
    replyTo?: RelayReplyTarget;
    invocationId?: string;
    idempotencyKey: string;
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
   * Apply part operations to a message. `expectedVersion` is the `version`
   * you last read: a stale value is refused rather than overwriting somebody
   * else's edit.
   */
  editMessage: (params: {
    messageId: RelayId;
    operationId?: RelayId;
    expectedVersion: number;
    operations: RelayPartOperation[];
    signal?: AbortSignal;
  }) => Promise<{ operationId: RelayId; message: RelayMessage }>;
  /** Unsend a message. Idempotent: a second call returns the same tombstone. */
  unsendMessage: (params: {
    messageId: RelayId;
    operationId?: RelayId;
    signal?: AbortSignal;
  }) => Promise<{ operationId: RelayId; message: RelayMessage }>;
  /**
   * Add, change or remove a reaction. Pass `targetPartId` to react to one
   * exact part; omit it for the whole message. Changing an emoji is an `add`
   * on the slot the previous one occupied.
   */
  react: (params: {
    messageId: RelayId;
    operation: "add" | "remove";
    emoji: string;
    targetPartId?: RelayId;
    operationId?: RelayId;
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
   * when the cursor moves past the event. Neither needs a line of code, and
   * neither can suppress it.
   *
   * The exception is a transcript poller — a client that reads
   * `GET /v1/conversations/:id/messages` on a timer. Reading history records
   * no receipt, so nothing on the server ever learns the message arrived.
   * That client, and only that client, has to say so itself.
   *
   * Send it on ingest, before anything that implies a read. The server
   * advances the delivered watermark whenever it records a read, so a
   * delivered receipt that arrives after a read for the same message is
   * silently dropped: the sender goes straight from "Sent" to "Read" and never
   * sees "Delivered". Skipping this call costs the middle rung of the ladder,
   * not the top one.
   */
  markDelivered: (params: {
    conversationId: string;
    messageId: RelayId;
    signal?: AbortSignal;
  }) => Promise<void>;
  /**
   * Recover from a `410 cursor_expired`. Read canonical history first: this
   * call asserts you did, and returns the cursor to resume from.
   */
  reconcileEvents: (params: {
    expiredCursor: number;
    historyReconciled: true;
    idempotencyKey?: string;
    signal?: AbortSignal;
  }) => Promise<RelayReconcileResult>;
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

/**
 * Build the body of a `PATCH /v2/messages/{id}`.
 *
 * Exported because it is the part of an edit worth testing without a server:
 * the operations are the caller's, and everything else is the retry and
 * concurrency contract. `operationId` defaults to a fresh `mut_` id, which is
 * correct for a first attempt and wrong for a retry, so a caller that retries
 * must pass the id it used the first time.
 */
export function buildEditRequest(params: {
  operationId?: RelayId;
  expectedVersion: number;
  operations: RelayPartOperation[];
}): RelayEditRequest {
  if (!Number.isInteger(params.expectedVersion) || params.expectedVersion < 1) {
    throw new Error("relay: expectedVersion must be the version you last read");
  }
  if (params.operations.length === 0) {
    throw new Error("relay: an edit needs at least one operation");
  }
  if (params.operations.length > MAX_OPERATIONS_PER_EDIT) {
    throw new Error(
      `relay: an edit takes at most ${MAX_OPERATIONS_PER_EDIT} operations`,
    );
  }
  return {
    operation_id: params.operationId ?? relayId("mut"),
    expected_version: params.expectedVersion,
    operations: params.operations,
  };
}

/** Relay refuses an edit with more operations than this. */
export const MAX_OPERATIONS_PER_EDIT = 64;

/**
 * What a poll should do about the gap between the cursor it holds and the
 * page it just read.
 *
 * A long poll returns `next_cursor` and the events between. A cursor that is
 * behind Relay's retention is `410 cursor_expired` and needs a history read
 * before it can resume; a cursor ahead of what Relay ever delivered is a
 * `422` and means this consumer's stored cursor is not Relay's. Both are
 * terminal to the loop and neither is repaired by retrying, so name them
 * rather than letting a caller retry into them forever.
 */
export type CursorGap =
  | { kind: "none"; resumeCursor: number }
  | { kind: "expired"; resumeFrom: number }
  | { kind: "ahead"; highestDeliveredCursor: number };

/**
 * Classify the error a poll failed with, or the page it succeeded with.
 *
 * ```ts
 * const gap = classifyCursorGap({ cursor, error });
 * if (gap.kind === "expired") {
 *   await readHistoryFrom(gap.resumeFrom);
 *   const { resumeCursor } = await client.reconcileEvents({
 *     expiredCursor: gap.resumeFrom,
 *     historyReconciled: true,
 *   });
 *   setCursor(resumeCursor);
 * }
 * ```
 */
export function classifyCursorGap(input: {
  cursor: number;
  error?: unknown;
  page?: RelayEventsPage;
}): CursorGap {
  const error = input.error;
  if (error instanceof RelayApiError) {
    if (error.status === 410 || error.code === "cursor_expired") {
      return { kind: "expired", resumeFrom: input.cursor };
    }
    const highest = error.details?.["highest_delivered_cursor"];
    if (typeof highest === "number") {
      return { kind: "ahead", highestDeliveredCursor: highest };
    }
  }
  return { kind: "none", resumeCursor: input.page?.nextCursor ?? input.cursor };
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
      // The server answers `{ message_id, messages }`. Reading `body.message`
      // here resolved every send with `message: undefined` while TypeScript
      // believed otherwise, and the fault surfaced later at the consumer.
      const body = (await response.json()) as {
        message_id?: string;
        messages?: RelayMessage[];
      };
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const first = messages[0];
      if (!first) {
        throw new RelayApiError("relay: send returned no committed messages", {
          status: response.status,
          kind: "retryable",
        });
      }
      return {
        messageId: typeof body.message_id === "string" ? body.message_id : first.id,
        message: first,
        messages,
      };
    },

    sendMessageV2: async (params) => {
      const messageId = params.messageId ?? relayId("msg");
      const response = await request({
        method: "POST",
        path: `/v2/conversations/${encodeURIComponent(params.conversationId)}/messages`,
        body: {
          message_id: messageId,
          parts: params.parts,
          ...(params.replyTo ? { reply_to: params.replyTo } : {}),
          ...(params.invokedAgentIds ? { invoked_agent_ids: params.invokedAgentIds } : {}),
          ...(params.fallbackText === undefined ? {} : { fallback_text: params.fallbackText }),
          ...(params.invocationId ? { invocation_id: params.invocationId } : {}),
        },
        ...(params.signal ? { signal: params.signal } : {}),
      });
      const body = (await response.json()) as { message?: RelayMessage };
      if (!body.message) {
        throw new RelayApiError("relay: v2 send returned no message", {
          status: response.status,
          kind: "retryable",
        });
      }
      return { messageId, message: body.message };
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

    editMessage: async (params) => {
      const operationId = params.operationId ?? relayId("mut");
      const response = await request({
        method: "PATCH",
        path: `/v2/messages/${encodeURIComponent(params.messageId)}`,
        body: buildEditRequest({
          operationId,
          expectedVersion: params.expectedVersion,
          operations: params.operations,
        }),
        ...(params.signal ? { signal: params.signal } : {}),
      });
      const body = (await response.json()) as { message?: RelayMessage };
      if (!body.message) {
        throw new RelayApiError("relay: edit returned no message", {
          status: response.status,
          kind: "retryable",
        });
      }
      return { operationId, message: body.message };
    },

    unsendMessage: async (params) => {
      const operationId = params.operationId ?? relayId("mut");
      const response = await request({
        method: "DELETE",
        path: `/v2/messages/${encodeURIComponent(params.messageId)}`,
        body: { operation_id: operationId },
        ...(params.signal ? { signal: params.signal } : {}),
      });
      const body = (await response.json()) as { message?: RelayMessage };
      if (!body.message) {
        throw new RelayApiError("relay: unsend returned no tombstone", {
          status: response.status,
          kind: "retryable",
        });
      }
      return { operationId, message: body.message };
    },

    react: async (params) => {
      const response = await request({
        method: "POST",
        path: `/v1/messages/${encodeURIComponent(params.messageId)}/reactions`,
        body: {
          operation: params.operation,
          type: "emoji",
          emoji: params.emoji,
          ...(params.targetPartId
            ? { target_scope: "part", target_part_id: params.targetPartId }
            : {}),
          operation_id: params.operationId ?? relayId("mut"),
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

    markDelivered: async (params) => {
      await request({
        method: "POST",
        path: `/v1/conversations/${encodeURIComponent(params.conversationId)}/delivered`,
        body: { message_id: params.messageId },
        ...(params.signal ? { signal: params.signal } : {}),
      });
    },

    reconcileEvents: async (params) => {
      const response = await request({
        method: "POST",
        path: "/v1/events/reconcile",
        headers: {
          "idempotency-key": params.idempotencyKey ?? `reconcile-${relayId("req")}`,
        },
        body: {
          expired_cursor: params.expiredCursor,
          history_reconciled: params.historyReconciled,
        },
        ...(params.signal ? { signal: params.signal } : {}),
      });
      const body = (await response.json()) as {
        reconciled?: boolean;
        resume_cursor?: number;
      };
      if (body.reconciled !== true || typeof body.resume_cursor !== "number") {
        throw new RelayApiError("relay: reconcile returned no resume cursor", {
          status: response.status,
          kind: "retryable",
        });
      }
      return { reconciled: true, resumeCursor: body.resume_cursor };
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
