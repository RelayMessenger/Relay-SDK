import type {
  RelayWebhookEnvelope,
  WebSocketConnection,
  WebSocketDisconnectFrame,
  WebSocketErrorFrame,
  WebSocketEventFrame,
  WebSocketReadyFrame,
} from "./types.js";
import { RelayAPIError } from "./errors.js";
import { RELAY_WEBHOOK_EVENT_TYPES } from "./operations.js";

export interface WebSocketEventContext {
  sequence: string;
}

export interface WebSocketLike {
  addEventListener(
    type: "message" | "close" | "error",
    listener: (event: any) => void,
  ): void;
  removeEventListener(
    type: "message" | "close" | "error",
    listener: (event: any) => void,
  ): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface WebSocketConstructor {
  new (url: string, protocols?: string | string[]): WebSocketLike;
}

export interface WebSocketRunOptions {
  signal?: AbortSignal;
  WebSocket?: WebSocketConstructor;
  minReconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  random?: () => number;
  onEvent(
    event: RelayWebhookEnvelope,
    context: WebSocketEventContext,
  ): Promise<void>;
  onError?(error: unknown): void;
}

const wait = (
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

const text = async (value: unknown): Promise<string> => {
  if (typeof value === "string") return value;
  if (value instanceof ArrayBuffer) {
    return new TextDecoder().decode(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new TextDecoder().decode(value);
  }
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    return value.text();
  }
  throw new Error("Relay WebSocket received a non-text frame.");
};

const validSequence = (value: unknown): value is string =>
  typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const hasExactKeys = (
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
};

const validUUID = (value: unknown): value is string =>
  typeof value === "string"
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(value);

const WEBHOOK_EVENT_TYPES = new Set<string>(RELAY_WEBHOOK_EVENT_TYPES);
const WEBSOCKET_ERROR_CODES = new Set([
  "invalid_frame",
  "ack_out_of_range",
  "stale_connection",
  "ack_failed",
  "delivery_failed",
]);
const CLIENT_CLOSE_DURABLE_ACCEPTANCE = 4001;
const CLIENT_CLOSE_PROTOCOL_ERROR = 4002;
const CLIENT_CLOSE_RECONNECT = 4003;

class WebSocketProtocolError extends Error {
  readonly closeCode = CLIENT_CLOSE_PROTOCOL_ERROR;
  readonly stop = true;
}

const parseReady = (value: unknown): WebSocketReadyFrame => {
  if (
    !isRecord(value)
    || !hasExactKeys(value, [
      "type",
      "connection_id",
      "acked_through",
      "heartbeat_interval_ms",
      "max_in_flight",
    ])
    || value.type !== "ready"
    || !validUUID(value.connection_id)
    || !validSequence(value.acked_through)
    || !Number.isInteger(value.heartbeat_interval_ms)
    || (value.heartbeat_interval_ms as number) < 1
    || !Number.isInteger(value.max_in_flight)
    || (value.max_in_flight as number) < 1
  ) {
    throw new WebSocketProtocolError(
      "Relay WebSocket received an invalid ready frame.",
    );
  }
  return value as unknown as WebSocketReadyFrame;
};

const parseEvent = (value: unknown): WebSocketEventFrame => {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ["type", "sequence", "event"])
    || value.type !== "event"
    || !validSequence(value.sequence)
    || !isRecord(value.event)
    || value.event.api_version !== "v1"
    || typeof value.event.webhook_version !== "string"
    || !WEBHOOK_EVENT_TYPES.has(String(value.event.event_type))
    || !validUUID(value.event.event_id)
    || typeof value.event.created_at !== "string"
    || typeof value.event.trace_id !== "string"
    || !validUUID(value.event.agent_id)
    || !isRecord(value.event.data)
  ) {
    throw new WebSocketProtocolError(
      "Relay WebSocket received an invalid event frame.",
    );
  }
  return value as unknown as WebSocketEventFrame;
};

const parseError = (value: unknown): WebSocketErrorFrame => {
  if (
    !isRecord(value)
    || !hasExactKeys(value, [
      "type",
      "code",
      "message",
      "fatal",
      "retryable",
    ])
    || value.type !== "error"
    || typeof value.code !== "string"
    || !WEBSOCKET_ERROR_CODES.has(value.code)
    || typeof value.message !== "string"
    || typeof value.fatal !== "boolean"
    || typeof value.retryable !== "boolean"
  ) {
    throw new WebSocketProtocolError(
      "Relay WebSocket received an invalid error frame.",
    );
  }
  return value as unknown as WebSocketErrorFrame;
};

const parseDisconnect = (value: unknown): WebSocketDisconnectFrame => {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ["type", "reason"])
    || value.type !== "disconnect"
    || ![
      "disabled",
      "replaced",
      "revoked",
      "heartbeat_timeout",
      "restart",
    ].includes(String(value.reason))
  ) {
    throw new WebSocketProtocolError(
      "Relay WebSocket received an invalid disconnect frame.",
    );
  }
  return value as unknown as WebSocketDisconnectFrame;
};

class WebSocketStoppedError extends Error {
  readonly stop = true;

  constructor(
    message: string,
    readonly closeCode = 1000,
  ) {
    super(message);
  }
}

class DurableAcceptanceError extends Error {
  readonly closeCode = CLIENT_CLOSE_DURABLE_ACCEPTANCE;

  constructor(cause: unknown) {
    super(
      `Relay WebSocket durable acceptance failed: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
  }
}

class RetryableWebSocketError extends Error {
  constructor(
    message: string,
    readonly closeCode = CLIENT_CLOSE_RECONNECT,
  ) {
    super(message);
  }
}

const parseConnection = (
  value: WebSocketConnection,
): WebSocketConnection => {
  const record = value as unknown;
  if (!isRecord(record)) {
    throw new WebSocketProtocolError(
      "Relay returned an invalid WebSocket connection ticket.",
    );
  }
  let url: URL;
  try {
    url = new URL(String(record.url));
  } catch {
    throw new WebSocketProtocolError(
      "Relay returned an invalid WebSocket connection ticket.",
    );
  }
  if (
    !hasExactKeys(record, [
      "url",
      "expires_at",
      "subprotocol",
    ])
    || typeof record.url !== "string"
    || typeof record.expires_at !== "string"
    || (url.protocol !== "ws:" && url.protocol !== "wss:")
    || url.username !== ""
    || url.password !== ""
    || Number.isNaN(Date.parse(record.expires_at))
    || record.subprotocol !== "relay.v1.json"
  ) {
    throw new WebSocketProtocolError(
      "Relay returned an invalid WebSocket connection ticket.",
    );
  }
  return value;
};

const runConnection = (
  connection: WebSocketConnection,
  options: WebSocketRunOptions,
  Constructor: WebSocketConstructor,
  onReady: () => void,
): Promise<void> =>
  new Promise((resolve, reject) => {
    const socket = new Constructor(connection.url, connection.subprotocol);
    let chain = Promise.resolve();
    let settled = false;
    let ready = false;
    let acceptedThrough: bigint | undefined;

    const finish = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
      socket.removeEventListener("error", onSocketError);
      options.signal?.removeEventListener("abort", onAbort);
      if (error === undefined) resolve();
      else reject(error);
    };
    const stopReceiving = (): void => {
      socket.removeEventListener("message", onMessage);
    };
    const onMessage = (message: { data: unknown }): void => {
      chain = chain.then(async () => {
        let frame: unknown;
        try {
          frame = JSON.parse(await text(message.data)) as unknown;
        } catch (cause) {
          throw new WebSocketProtocolError(
            cause instanceof SyntaxError
              ? "Relay WebSocket received invalid JSON."
              : "Relay WebSocket received a non-text frame.",
          );
        }
        if (isRecord(frame) && frame.type === "ready") {
          if (ready) {
            throw new WebSocketProtocolError(
              "Relay WebSocket received more than one ready frame.",
            );
          }
          const parsed = parseReady(frame);
          ready = true;
          acceptedThrough = BigInt(parsed.acked_through);
          onReady();
          return;
        }
        if (isRecord(frame) && frame.type === "disconnect") {
          const parsed = parseDisconnect(frame);
          if (
            parsed.reason === "heartbeat_timeout"
            || parsed.reason === "restart"
          ) {
            throw new RetryableWebSocketError(
              parsed.reason === "restart"
                ? "Relay WebSocket is restarting."
                : "Relay WebSocket heartbeat timed out.",
            );
          }
          throw new WebSocketStoppedError(
            `Relay WebSocket disconnected permanently: ${parsed.reason}.`,
            parsed.reason === "replaced" ? 4409 : 4401,
          );
        }
        if (isRecord(frame) && frame.type === "error") {
          const parsed = parseError(frame);
          if (!parsed.retryable) {
            throw new WebSocketStoppedError(parsed.message);
          }
          throw new RetryableWebSocketError(parsed.message);
        }
        if (!ready || acceptedThrough === undefined) {
          throw new WebSocketProtocolError(
            "Relay WebSocket received an event before the ready frame.",
          );
        }
        const event = parseEvent(frame);
        const sequence = BigInt(event.sequence);
        if (sequence !== acceptedThrough + 1n) {
          throw new WebSocketProtocolError(
            "Relay WebSocket received a non-contiguous event sequence.",
          );
        }
        try {
          await options.onEvent(event.event, { sequence: event.sequence });
        } catch (cause) {
          throw new DurableAcceptanceError(cause);
        }
        acceptedThrough = sequence;
        if (options.signal?.aborted) return;
        socket.send(JSON.stringify({
          type: "ack",
          through_sequence: event.sequence,
        }));
      }).catch((error) => {
        stopReceiving();
        socket.close(
          error instanceof WebSocketStoppedError
            ? error.closeCode
            : error instanceof WebSocketProtocolError
              ? error.closeCode
              : error instanceof RetryableWebSocketError
                ? error.closeCode
              : CLIENT_CLOSE_DURABLE_ACCEPTANCE,
          error instanceof WebSocketStoppedError
            ? "Relay stopped this consumer"
            : error instanceof WebSocketProtocolError
              ? "protocol error"
              : error instanceof RetryableWebSocketError
                ? "Relay requested reconnect"
              : "durable acceptance failed",
        );
        finish(error);
      });
    };
    const onClose = (event: { code?: number; reason?: string }): void => {
      stopReceiving();
      void chain.then(() => {
        if (event.code === 4409) {
          finish(new WebSocketStoppedError(
            `Relay WebSocket closed permanently (${event.code}): ${event.reason ?? "authorization or ownership changed"}.`,
          ));
          return;
        }
        if (!ready) {
          finish(new Error(
            `Relay WebSocket closed before ready (${event.code ?? 1006}): ${event.reason ?? "connection ended"}.`,
          ));
          return;
        }
        finish();
      }, finish);
    };
    const onSocketError = (): void => {
      stopReceiving();
      const error = new Error("Relay WebSocket connection failed.");
      void chain.then(() => finish(error), finish);
    };
    const onAbort = (): void => {
      stopReceiving();
      socket.close(1000, "aborted");
      void chain.then(() => finish(), finish);
    };

    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose);
    socket.addEventListener("error", onSocketError);
    options.signal?.addEventListener("abort", onAbort, { once: true });
  });

export const runWebSocket = async (
  createConnection: () => Promise<WebSocketConnection>,
  options: WebSocketRunOptions,
): Promise<void> => {
  const Constructor = options.WebSocket
    ?? (globalThis as typeof globalThis & {
      WebSocket?: WebSocketConstructor;
    }).WebSocket;
  if (!Constructor) {
    throw new Error(
      "A WebSocket implementation is required in this runtime.",
    );
  }
  const minimum = options.minReconnectDelayMs ?? 500;
  const maximum = options.maxReconnectDelayMs ?? 30_000;
  if (
    !Number.isFinite(minimum)
    || !Number.isFinite(maximum)
    || minimum < 0
    || maximum < minimum
  ) {
    throw new RangeError(
      "WebSocket reconnect delays must be finite and maxReconnectDelayMs must be at least minReconnectDelayMs.",
    );
  }
  const random = options.random ?? Math.random;
  let attempt = 0;

  while (!options.signal?.aborted) {
    try {
      await runConnection(
        parseConnection(await createConnection()),
        options,
        Constructor,
        () => {
          attempt = 0;
        },
      );
    } catch (error) {
      if (options.signal?.aborted) return;
      options.onError?.(error);
      if (
        error instanceof WebSocketStoppedError
        || error instanceof WebSocketProtocolError
        || (error instanceof RelayAPIError && !error.retryable)
      ) throw error;
      attempt += 1;
    }
    if (options.signal?.aborted) return;
    const ceiling = Math.min(
      maximum,
      minimum * 2 ** Math.max(0, attempt - 1),
    );
    await wait(Math.floor(random() * ceiling), options.signal);
  }
};
