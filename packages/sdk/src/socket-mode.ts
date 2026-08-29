import type {
  RelayWebhookEnvelope,
  SocketConnection,
  SocketEventFrame,
} from "./types.js";

export interface SocketModeEventContext {
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

export interface SocketModeRunOptions {
  signal?: AbortSignal;
  WebSocket?: WebSocketConstructor;
  minReconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  random?: () => number;
  onEvent(
    event: RelayWebhookEnvelope,
    context: SocketModeEventContext,
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
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
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
  throw new Error("Relay Socket Mode received a non-text frame.");
};

const validSequence = (value: unknown): value is string =>
  typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value);

const parseEvent = (value: unknown): SocketEventFrame => {
  if (
    !value
    || typeof value !== "object"
    || !("type" in value)
    || value.type !== "event"
    || !("sequence" in value)
    || !validSequence(value.sequence)
    || !("event" in value)
    || !value.event
    || typeof value.event !== "object"
  ) {
    throw new Error("Relay Socket Mode received an invalid event frame.");
  }
  return value as SocketEventFrame;
};

const runConnection = (
  connection: SocketConnection,
  options: SocketModeRunOptions,
  Constructor: WebSocketConstructor,
): Promise<void> =>
  new Promise((resolve, reject) => {
    const socket = new Constructor(connection.url, connection.subprotocol);
    let chain = Promise.resolve();
    let settled = false;

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
    const onMessage = (message: { data: unknown }): void => {
      chain = chain.then(async () => {
        const frame = JSON.parse(await text(message.data)) as unknown;
        if (
          frame
          && typeof frame === "object"
          && "type" in frame
          && frame.type === "ready"
        ) return;
        if (
          frame
          && typeof frame === "object"
          && "type" in frame
          && frame.type === "disconnect"
        ) {
          socket.close(1000, "Relay requested reconnect");
          return;
        }
        if (
          frame
          && typeof frame === "object"
          && "type" in frame
          && frame.type === "error"
        ) {
          throw new Error(
            "message" in frame && typeof frame.message === "string"
              ? frame.message
              : "Relay Socket Mode returned an error.",
          );
        }
        const event = parseEvent(frame);
        await options.onEvent(event.event, { sequence: event.sequence });
        socket.send(JSON.stringify({
          type: "ack",
          through_sequence: event.sequence,
        }));
      }).catch((error) => {
        socket.close(1011, "durable acceptance failed");
        finish(error);
      });
    };
    const onClose = (): void => {
      void chain.then(() => finish(), finish);
    };
    const onSocketError = (): void => {
      finish(new Error("Relay Socket Mode connection failed."));
    };
    const onAbort = (): void => {
      socket.close(1000, "aborted");
      void chain.then(() => finish(), finish);
    };

    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose);
    socket.addEventListener("error", onSocketError);
    options.signal?.addEventListener("abort", onAbort, { once: true });
  });

export const runSocketMode = async (
  createConnection: () => Promise<SocketConnection>,
  options: SocketModeRunOptions,
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
  const random = options.random ?? Math.random;
  let attempt = 0;

  while (!options.signal?.aborted) {
    try {
      await runConnection(
        await createConnection(),
        options,
        Constructor,
      );
      attempt = 0;
    } catch (error) {
      if (options.signal?.aborted) return;
      options.onError?.(error);
      attempt += 1;
    }
    if (options.signal?.aborted) return;
    const ceiling = Math.min(maximum, minimum * 2 ** attempt);
    await wait(Math.floor(random() * ceiling), options.signal);
  }
};
