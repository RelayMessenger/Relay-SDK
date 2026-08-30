import { beforeEach, expect, it, vi } from "vitest";
import { once } from "node:events";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import Relay, {
  RelayWebhookConfiguredError,
  runWebSocket,
  type RelayWebhookEnvelope,
  type WebSocketLike,
} from "../src/index.js";

class FakeWebSocket implements WebSocketLike {
  static readonly instances: FakeWebSocket[] = [];

  readonly listeners = new Map<string, Set<(event: any) => void>>();
  readonly sent: string[] = [];
  readonly closeCalls: Array<{ code?: number; reason?: string }> = [];
  sendError: Error | undefined;

  constructor(
    readonly url: string,
    readonly options?: { headers?: Record<string, string> },
  ) {
    FakeWebSocket.instances.push(this);
  }

  static get latest(): FakeWebSocket {
    const socket = FakeWebSocket.instances.at(-1);
    if (!socket) throw new Error("No FakeWebSocket was created.");
    return socket;
  }

  addEventListener(type: string, listener: (event: any) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: any) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string): void {
    if (this.sendError) throw this.sendError;
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    if (
      code !== undefined
      && code !== 1000
      && (code < 3000 || code > 4999)
    ) {
      throw new DOMException("invalid code", "InvalidAccessError");
    }
    this.closeCalls.push({ code, reason });
    queueMicrotask(() => this.emit("close", { code, reason }));
  }

  emit(type: string, event: any): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  on(type: string, listener: (...args: any[]) => void): this {
    this.addEventListener(type, listener);
    return this;
  }

  off(type: string, listener: (...args: any[]) => void): this {
    this.removeEventListener(type, listener);
    return this;
  }
}

beforeEach(() => {
  FakeWebSocket.instances.length = 0;
});

const turn = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

const waitFor = async (predicate: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await turn();
  }
  throw new Error("Timed out waiting for WebSocket test state.");
};

const envelope = (
  eventID = "01993d50-ef7b-7b37-886b-23fd80c7ec11",
): RelayWebhookEnvelope => ({
  api_version: "v1",
  webhook_version: "2026-02-03",
  event_type: "message.received",
  event_id: eventID,
  created_at: "2026-08-29T06:20:00.000Z",
  trace_id: "trace",
  agent_id: "01993d50-d2a8-7fe2-8b76-9eaf04816377",
  data: {},
});

const ready = (
  ackedThrough = "0",
  fullSyncThrough: string | null = null,
) => ({
  type: "ready",
  connection_id: "01993d50-ef7b-7b37-886b-23fd80c7ec10",
  acked_through: ackedThrough,
  full_sync_required: fullSyncThrough !== null,
  full_sync_through: fullSyncThrough,
  heartbeat_interval_ms: 30_000,
  max_in_flight: 64,
});

const eventFrame = (
  sequence: string,
  event = envelope(),
) => ({
  type: "event",
  sequence,
  event,
});

const fullSyncFrame = (throughSequence: string) => ({
  type: "full_sync",
  through_sequence: throughSequence,
  reason: "checkpoint_outside_retention",
});

const emitFrame = (socket: FakeWebSocket, frame: unknown): void => {
  socket.emit("message", { data: JSON.stringify(frame) });
};

const client = (baseURL = "https://relay.test/some-old-path?ignored=1"): Relay =>
  new Relay({ apiKey: "relay-agent-token", baseURL });

const run = (
  relay: Relay,
  overrides: Partial<Parameters<typeof relay.websocket.run>[0]> = {},
): { controller: AbortController; running: Promise<void> } => {
  const controller = new AbortController();
  return {
    controller,
    running: relay.websocket.run({
      signal: controller.signal,
      WebSocket: FakeWebSocket,
      minReconnectDelayMs: 0,
      maxReconnectDelayMs: 0,
      onEvent: async () => {},
      onFullSync: async () => {},
      ...overrides,
    }),
  };
};

it("derives /v1/websocket and sends the Agent Token header with no protocol", async () => {
  const { controller, running } = run(client());
  await waitFor(() => FakeWebSocket.instances.length === 1);

  const socket = FakeWebSocket.latest;
  expect(socket.url).toBe("wss://relay.test/v1/websocket");
  expect(socket.options).toEqual({
    headers: { Authorization: "Bearer relay-agent-token" },
  });
  expect(typeof socket.options).toBe("object");
  expect(socket.url).not.toContain("token");
  expect(socket.url).not.toContain("ticket");

  controller.abort();
  await running;
});

it("uses ws for an HTTP Relay baseURL", async () => {
  const { controller, running } = run(client("http://127.0.0.1:8790"));
  await waitFor(() => FakeWebSocket.instances.length === 1);
  expect(FakeWebSocket.latest.url).toBe("ws://127.0.0.1:8790/v1/websocket");
  controller.abort();
  await running;
});

it("sends direct Agent Token auth and no subprotocol with the real ws client", async () => {
  const server = createServer();
  const webSocketServer = new WebSocketServer({ noServer: true });
  let authorization: string | undefined;
  let protocol: string | undefined;
  let connected = false;
  server.on("upgrade", (request, socket, head) => {
    authorization = request.headers.authorization;
    protocol = request.headers["sec-websocket-protocol"];
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocketServer.emit("connection", webSocket, request);
    });
  });
  webSocketServer.on("connection", (webSocket) => {
    connected = true;
    webSocket.send(JSON.stringify(ready()));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP test server.");
  }

  const controller = new AbortController();
  const running = runWebSocket(
    `http://127.0.0.1:${address.port}/ignored`,
    "real-agent-token",
    {
      signal: controller.signal,
      onEvent: async () => {},
      onFullSync: async () => {},
    },
  );
  await waitFor(() => authorization !== undefined && connected);
  await turn();

  expect(authorization).toBe("Bearer real-agent-token");
  expect(protocol).toBeUndefined();

  controller.abort();
  await running;
  await new Promise<void>((resolve) => webSocketServer.close(() => resolve()));
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
});

it("returns a typed HTTP 409 error when Webhooks configure the Agent path", async () => {
  const server = createServer();
  const body = JSON.stringify({
    error: {
      status: 409,
      message: "This Agent delivers by webhook; delete its webhook subscription to use the WebSocket.",
    },
    trace_id: "trace-webhook-conflict",
  });
  let upgrades = 0;
  server.on("upgrade", (_request, socket) => {
    upgrades += 1;
    socket.end([
      "HTTP/1.1 409 Conflict",
      "Content-Type: application/json",
      `Content-Length: ${Buffer.byteLength(body)}`,
      "Connection: close",
      "",
      body,
    ].join("\r\n"));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP test server.");
  }

  const error = await runWebSocket(
    `http://127.0.0.1:${address.port}`,
    "agent-with-webhook",
    {
      minReconnectDelayMs: 0,
      maxReconnectDelayMs: 0,
      onEvent: async () => {},
      onFullSync: async () => {},
    },
  ).catch((cause) => cause);

  expect(error).toBeInstanceOf(RelayWebhookConfiguredError);
  expect(error).toMatchObject({
    status: 409,
    traceId: "trace-webhook-conflict",
    retryable: false,
  });
  expect(String(error)).toContain("delete its webhook subscription");
  expect(upgrades).toBe(1);

  await new Promise<void>((resolve, reject) => {
    server.close((cause) => cause ? reject(cause) : resolve());
  });
});

it("ACKs only after the event callback durably resolves", async () => {
  let commit: (() => void) | undefined;
  const durable = new Promise<void>((resolve) => {
    commit = resolve;
  });
  const received: string[] = [];
  const { controller, running } = run(client(), {
    onEvent: async (event) => {
      received.push(event.event_id);
      await durable;
    },
  });
  await waitFor(() => FakeWebSocket.instances.length === 1);
  const socket = FakeWebSocket.latest;
  emitFrame(socket, ready());
  emitFrame(socket, eventFrame("1"));
  await turn();

  expect(received).toEqual([envelope().event_id]);
  expect(socket.sent).toEqual([]);

  commit!();
  await waitFor(() => socket.sent.length === 1);
  expect(socket.sent.map(JSON.parse)).toEqual([{
    type: "ack",
    through_sequence: "1",
  }]);

  controller.abort();
  await running;
});

it("durably applies FULL sync before completing it or ACKing queued events", async () => {
  let commit: (() => void) | undefined;
  const durable = new Promise<void>((resolve) => {
    commit = resolve;
  });
  const syncContexts: unknown[] = [];
  const eventSequences: string[] = [];
  const { controller, running } = run(client(), {
    onFullSync: async (context) => {
      syncContexts.push(context);
      await durable;
    },
    onEvent: async (_event, context) => {
      eventSequences.push(context.sequence);
    },
  });
  await waitFor(() => FakeWebSocket.instances.length === 1);
  const socket = FakeWebSocket.latest;

  emitFrame(socket, ready("7", "42"));
  emitFrame(socket, fullSyncFrame("42"));
  emitFrame(socket, eventFrame("43"));
  await turn();

  expect(syncContexts).toEqual([{
    throughSequence: "42",
    reason: "checkpoint_outside_retention",
  }]);
  expect(eventSequences).toEqual([]);
  expect(socket.sent).toEqual([]);

  commit!();
  await waitFor(() => socket.sent.length === 2);
  expect(eventSequences).toEqual(["43"]);
  expect(socket.sent.map(JSON.parse)).toEqual([
    { type: "full_sync_complete", through_sequence: "42" },
    { type: "ack", through_sequence: "43" },
  ]);

  controller.abort();
  await running;
});

it("does not complete or ACK when durable FULL sync fails, then reconnects", async () => {
  const errors: unknown[] = [];
  const { controller, running } = run(client(), {
    onFullSync: async () => {
      throw new Error("snapshot commit failed");
    },
    onError(error) {
      errors.push(error);
    },
  });
  await waitFor(() => FakeWebSocket.instances.length === 1);
  const first = FakeWebSocket.latest;
  emitFrame(first, ready("0", "9"));
  emitFrame(first, fullSyncFrame("9"));
  emitFrame(first, eventFrame("10"));
  await waitFor(() => FakeWebSocket.instances.length === 2);

  expect(first.sent).toEqual([]);
  expect(first.closeCalls[0]).toEqual({
    code: 4001,
    reason: "durable application failed",
  });
  expect(String(errors[0])).toContain("FULL sync");

  controller.abort();
  await running;
});

it("rejects events received while the ready frame says FULL sync is pending", async () => {
  const { running } = run(client());
  await waitFor(() => FakeWebSocket.instances.length === 1);
  const socket = FakeWebSocket.latest;
  emitFrame(socket, ready("0", "8"));
  emitFrame(socket, eventFrame("1"));

  await expect(running).rejects.toThrow("FULL sync was pending");
  expect(socket.sent).toEqual([]);
  expect(socket.closeCalls[0]).toEqual({
    code: 4002,
    reason: "protocol error",
  });
});

it("rejects a FULL-sync checkpoint that does not match ready", async () => {
  let callbacks = 0;
  const { running } = run(client(), {
    onFullSync: async () => {
      callbacks += 1;
    },
  });
  await waitFor(() => FakeWebSocket.instances.length === 1);
  const socket = FakeWebSocket.latest;
  emitFrame(socket, ready("0", "8"));
  emitFrame(socket, fullSyncFrame("9"));

  await expect(running).rejects.toThrow("did not match");
  expect(callbacks).toBe(0);
  expect(socket.sent).toEqual([]);
});

it("uses a private close code, sends no ACK, and reconnects after event durability fails", async () => {
  const errors: unknown[] = [];
  const { controller, running } = run(client(), {
    onEvent: async () => {
      throw new Error("disk commit failed");
    },
    onError(error) {
      errors.push(error);
    },
  });
  await waitFor(() => FakeWebSocket.instances.length === 1);
  const first = FakeWebSocket.latest;
  emitFrame(first, ready());
  emitFrame(first, eventFrame("1"));
  await waitFor(() => FakeWebSocket.instances.length === 2);

  expect(errors).toHaveLength(1);
  expect(first.sent).toEqual([]);
  expect(first.closeCalls[0]).toEqual({
    code: 4001,
    reason: "durable application failed",
  });

  controller.abort();
  await running;
});

it.each([1011, 1012, 4408])(
  "reconnects with the same direct Agent Token auth after transient close %s",
  async (code) => {
    const { controller, running } = run(client());
    await waitFor(() => FakeWebSocket.instances.length === 1);
    const first = FakeWebSocket.latest;
    emitFrame(first, ready());
    first.emit("close", { code, reason: "transient" });
    await waitFor(() => FakeWebSocket.instances.length === 2);

    expect(FakeWebSocket.latest.url).toBe("wss://relay.test/v1/websocket");
    expect(FakeWebSocket.latest.options?.headers?.Authorization)
      .toBe("Bearer relay-agent-token");

    controller.abort();
    await running;
  },
);

it("uses capped jittered exponential delay across consecutive connection failures", async () => {
  vi.useFakeTimers();
  try {
    class ClosingWebSocket extends FakeWebSocket {
      constructor(
        url: string,
        options?: { headers?: Record<string, string> },
      ) {
        super(url, options);
        queueMicrotask(() => {
          this.emit("close", { code: 1011, reason: "before ready" });
        });
      }
    }
    const controller = new AbortController();
    const running = runWebSocket(
      "https://relay.test",
      "agent-token",
      {
        signal: controller.signal,
        WebSocket: ClosingWebSocket,
        minReconnectDelayMs: 10,
        maxReconnectDelayMs: 25,
        random: () => 1,
        onEvent: async () => {},
        onFullSync: async () => {},
      },
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(FakeWebSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(9);
    expect(FakeWebSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeWebSocket.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(19);
    expect(FakeWebSocket.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeWebSocket.instances).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(24);
    expect(FakeWebSocket.instances).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeWebSocket.instances).toHaveLength(4);

    controller.abort();
    await vi.runAllTimersAsync();
    await running;
  } finally {
    vi.useRealTimers();
  }
});

it.each(["heartbeat_timeout", "restart"] as const)(
  "reconnects after a %s disconnect frame",
  async (reason) => {
    const { controller, running } = run(client());
    await waitFor(() => FakeWebSocket.instances.length === 1);
    emitFrame(FakeWebSocket.latest, ready());
    emitFrame(FakeWebSocket.latest, { type: "disconnect", reason });
    await waitFor(() => FakeWebSocket.instances.length === 2);
    controller.abort();
    await running;
  },
);

it.each([
  [4401, "invalid Agent Token"],
  [4409, "replaced"],
] as const)("does not reconnect after terminal close %s", async (code, reason) => {
  const errors: unknown[] = [];
  const { running } = run(client(), {
    onError(error) {
      errors.push(error);
    },
  });
  await waitFor(() => FakeWebSocket.instances.length === 1);
  FakeWebSocket.latest.emit("close", { code, reason });

  await expect(running).rejects.toThrow(String(code));
  expect(FakeWebSocket.instances).toHaveLength(1);
  expect(errors).toHaveLength(1);
});

it("treats an otherwise unknown server policy close as terminal", async () => {
  const { running } = run(client());
  await waitFor(() => FakeWebSocket.instances.length === 1);
  emitFrame(FakeWebSocket.latest, ready());
  FakeWebSocket.latest.emit("close", {
    code: 4499,
    reason: "server delivery policy changed",
  });

  await expect(running).rejects.toThrow("4499");
  expect(FakeWebSocket.instances).toHaveLength(1);
});

it.each(["replaced", "revoked"] as const)(
  "stops after a %s disconnect frame",
  async (reason) => {
    const { running } = run(client());
    await waitFor(() => FakeWebSocket.instances.length === 1);
    const socket = FakeWebSocket.latest;
    emitFrame(socket, ready());
    emitFrame(socket, { type: "disconnect", reason });

    await expect(running).rejects.toThrow(reason);
    expect(FakeWebSocket.instances).toHaveLength(1);
  },
);

it("pings after 30 seconds and reconnects after 60 seconds without a pong", async () => {
  vi.useFakeTimers();
  try {
    class HeartbeatWebSocket extends FakeWebSocket {
      pingCalls = 0;

      ping(): void {
        this.pingCalls += 1;
      }
    }
    const errors: unknown[] = [];
    const controller = new AbortController();
    const running = runWebSocket(
      "https://relay.test",
      "agent-token",
      {
        signal: controller.signal,
        WebSocket: HeartbeatWebSocket,
        minReconnectDelayMs: 0,
        maxReconnectDelayMs: 0,
        onEvent: async () => {},
        onFullSync: async () => {},
        onError(error) {
          errors.push(error);
        },
      },
    );

    await vi.advanceTimersByTimeAsync(0);
    const first = FakeWebSocket.latest as HeartbeatWebSocket;
    emitFrame(first, ready());
    await vi.advanceTimersByTimeAsync(29_999);
    expect(first.pingCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(first.pingCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(FakeWebSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersToNextTimerAsync();
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(String(errors[0])).toContain("pong within 60 seconds");

    controller.abort();
    await vi.runAllTimersAsync();
    await running;
  } finally {
    vi.useRealTimers();
  }
});

it("keeps the 30-second heartbeat alive when pong frames arrive", async () => {
  vi.useFakeTimers();
  try {
    class HeartbeatWebSocket extends FakeWebSocket {
      pingCalls = 0;

      ping(): void {
        this.pingCalls += 1;
      }
    }
    const controller = new AbortController();
    const running = runWebSocket(
      "https://relay.test",
      "agent-token",
      {
        signal: controller.signal,
        WebSocket: HeartbeatWebSocket,
        onEvent: async () => {},
        onFullSync: async () => {},
      },
    );

    await vi.advanceTimersByTimeAsync(0);
    const socket = FakeWebSocket.latest as HeartbeatWebSocket;
    emitFrame(socket, ready());
    await vi.advanceTimersByTimeAsync(30_000);
    expect(socket.pingCalls).toBe(1);
    socket.emit("pong", {});
    await vi.advanceTimersByTimeAsync(30_000);
    expect(socket.pingCalls).toBe(2);
    expect(FakeWebSocket.instances).toHaveLength(1);

    controller.abort();
    await vi.runAllTimersAsync();
    await running;
  } finally {
    vi.useRealTimers();
  }
});

it("enforces contiguous decimal sequences without Number precision loss", async () => {
  const received: string[] = [];
  const { running } = run(client(), {
    onEvent: async (_event, context) => {
      received.push(context.sequence);
    },
  });
  await waitFor(() => FakeWebSocket.instances.length === 1);
  const socket = FakeWebSocket.latest;
  emitFrame(socket, ready("9007199254740992"));
  emitFrame(socket, eventFrame("9007199254740993"));
  await waitFor(() => socket.sent.length === 1);
  emitFrame(socket, eventFrame("9007199254740995"));

  await expect(running).rejects.toThrow("non-contiguous");
  expect(received).toEqual(["9007199254740993"]);
  expect(socket.sent.map(JSON.parse)).toEqual([{
    type: "ack",
    through_sequence: "9007199254740993",
  }]);
});

it("replays an unacknowledged event after reconnect for durable deduplication", async () => {
  const stored = new Set<string>();
  let callbacks = 0;
  const { controller, running } = run(client(), {
    onEvent: async (event) => {
      callbacks += 1;
      stored.add(event.event_id);
    },
  });
  await waitFor(() => FakeWebSocket.instances.length === 1);
  const first = FakeWebSocket.latest;
  first.sendError = new Error("connection dropped after commit");
  emitFrame(first, ready());
  emitFrame(first, eventFrame("1"));
  await waitFor(() => FakeWebSocket.instances.length === 2);

  const replay = FakeWebSocket.latest;
  emitFrame(replay, ready());
  emitFrame(replay, eventFrame("1"));
  await waitFor(() => replay.sent.length === 1);

  expect(callbacks).toBe(2);
  expect(stored).toEqual(new Set([envelope().event_id]));
  expect(replay.sent.map(JSON.parse)).toEqual([{
    type: "ack",
    through_sequence: "1",
  }]);

  controller.abort();
  await running;
});

it("rejects invalid reconnect options before opening a socket", async () => {
  await expect(runWebSocket(
    "https://relay.test",
    "agent-token",
    {
      WebSocket: FakeWebSocket,
      minReconnectDelayMs: 10,
      maxReconnectDelayMs: 5,
      onEvent: async () => {},
      onFullSync: async () => {},
    },
  )).rejects.toThrow(RangeError);
  expect(FakeWebSocket.instances).toHaveLength(0);
});

it("rejects invalid base URLs and empty Agent Tokens before opening a socket", async () => {
  const options = {
    WebSocket: FakeWebSocket,
    onEvent: async () => {},
    onFullSync: async () => {},
  };
  await expect(runWebSocket("file:///tmp/relay", "token", options))
    .rejects.toThrow("HTTP(S)");
  await expect(runWebSocket("https://relay.test", " ", options))
    .rejects.toThrow("Agent Token");
  expect(FakeWebSocket.instances).toHaveLength(0);
});
