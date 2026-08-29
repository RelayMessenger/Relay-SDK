import { beforeEach, expect, it } from "vitest";
import Relay, {
  runWebSocket,
  type RelayWebhookEnvelope,
  type WebSocketLike,
} from "../src/index.js";
import { RelayAPIError } from "../src/errors.js";

class FakeWebSocket implements WebSocketLike {
  static readonly instances: FakeWebSocket[] = [];

  readonly listeners = new Map<string, Set<(event: any) => void>>();
  readonly sent: string[] = [];
  readonly closeCalls: Array<{ code?: number; reason?: string }> = [];
  sendError: Error | undefined;

  constructor(
    readonly url: string,
    readonly protocol?: string | string[],
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

const ready = (ackedThrough = "0") => ({
  type: "ready",
  connection_id: "01993d50-ef7b-7b37-886b-23fd80c7ec10",
  acked_through: ackedThrough,
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

const emitFrame = (socket: FakeWebSocket, frame: unknown): void => {
  socket.emit("message", { data: JSON.stringify(frame) });
};

const clientWithTickets = (): { client: Relay; tickets: () => number } => {
  let tickets = 0;
  const client = new Relay({
    apiKey: "agent-token",
    fetch: async (input) => {
      expect(new URL(input instanceof Request ? input.url : input).pathname)
        .toBe("/v1/websocket-connections");
      tickets += 1;
      return Response.json({
        url: `wss://relay.test/v1/websocket?ticket=${tickets}`,
        expires_at: "2026-08-29T06:30:00.000Z",
        subprotocol: "relay.v1.json",
      });
    },
  });
  return { client, tickets: () => tickets };
};

it("ACKs only after the durable event callback resolves", async () => {
  const controller = new AbortController();
  let commit: (() => void) | undefined;
  const durable = new Promise<void>((resolve) => {
    commit = resolve;
  });
  const received: string[] = [];
  const { client } = clientWithTickets();

  const running = client.websocket.run({
    signal: controller.signal,
    WebSocket: FakeWebSocket,
    minReconnectDelayMs: 1,
    maxReconnectDelayMs: 1,
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
  expect(socket.sent.map((value) => JSON.parse(value))).toEqual([{
    type: "ack",
    through_sequence: "1",
  }]);

  controller.abort();
  await running;
});

it("uses a valid private close code, does not ACK, and reconnects after durable acceptance fails", async () => {
  const controller = new AbortController();
  const errors: unknown[] = [];
  const { client } = clientWithTickets();

  const running = client.websocket.run({
    signal: controller.signal,
    WebSocket: FakeWebSocket,
    minReconnectDelayMs: 0,
    maxReconnectDelayMs: 0,
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
    reason: "durable acceptance failed",
  });

  controller.abort();
  await running;
});

it.each(["disabled", "replaced", "revoked"] as const)(
  "stops instead of reconnecting after a %s disconnect",
  async (reason) => {
    const errors: unknown[] = [];
    const { client, tickets } = clientWithTickets();
    const running = client.websocket.run({
      WebSocket: FakeWebSocket,
      minReconnectDelayMs: 0,
      maxReconnectDelayMs: 0,
      onEvent: async () => {},
      onError(error) {
        errors.push(error);
      },
    });
    await waitFor(() => FakeWebSocket.instances.length === 1);
    const socket = FakeWebSocket.latest;
    emitFrame(socket, ready());
    emitFrame(socket, { type: "disconnect", reason });
    await expect(running).rejects.toThrow(reason);

    expect(tickets()).toBe(1);
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain(reason);
    expect(socket.closeCalls[0]).toEqual({
      code: reason === "replaced" ? 4409 : 4401,
      reason: "Relay stopped this consumer",
    });
  },
);

it.each(["heartbeat_timeout", "restart"] as const)(
  "gets a fresh ticket and reconnects after %s",
  async (reason) => {
    const controller = new AbortController();
    const errors: unknown[] = [];
    const { client, tickets } = clientWithTickets();
    const running = client.websocket.run({
      signal: controller.signal,
      WebSocket: FakeWebSocket,
      minReconnectDelayMs: 0,
      maxReconnectDelayMs: 0,
      onEvent: async () => {},
      onError(error) {
        errors.push(error);
      },
    });
    await waitFor(() => FakeWebSocket.instances.length === 1);
    const first = FakeWebSocket.latest;
    emitFrame(first, ready());
    emitFrame(first, { type: "disconnect", reason });
    await waitFor(() => FakeWebSocket.instances.length === 2);

    expect(tickets()).toBe(2);
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain(
      reason === "restart" ? "restarting" : "heartbeat",
    );
    expect(first.closeCalls[0]).toEqual({
      code: 4003,
      reason: "Relay requested reconnect",
    });

    controller.abort();
    await running;
  },
);

it("retries an invalid 4401 ticket, then can stop on API authorization", async () => {
  const errors: unknown[] = [];
  let attempts = 0;
  await expect(runWebSocket(
    async () => {
      attempts += 1;
      if (attempts === 1) {
        return {
          url: "wss://relay.test/v1/websocket?ticket=expired",
          expires_at: "2026-08-29T06:30:00.000Z",
          subprotocol: "relay.v1.json",
        };
      }
      throw new RelayAPIError("revoked", { status: 401 });
    },
    {
      WebSocket: class extends FakeWebSocket {
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols);
          queueMicrotask(() => {
            this.emit("close", { code: 4401, reason: "invalid ticket" });
          });
        }
      },
      minReconnectDelayMs: 0,
      maxReconnectDelayMs: 0,
      onEvent: async () => {},
      onError(error) {
        errors.push(error);
      },
    },
  )).rejects.toBeInstanceOf(RelayAPIError);

  expect(attempts).toBe(2);
  expect(errors).toHaveLength(2);
  expect(String(errors[0])).toContain("closed before ready");
  expect(errors[1]).toBeInstanceOf(RelayAPIError);
});

it("stops after a 4409 fencing close even when the disconnect frame is lost", async () => {
  const errors: unknown[] = [];
  const { client, tickets } = clientWithTickets();
  const running = client.websocket.run({
    WebSocket: FakeWebSocket,
    minReconnectDelayMs: 0,
    maxReconnectDelayMs: 0,
    onEvent: async () => {},
    onError(error) {
      errors.push(error);
    },
  });
  await waitFor(() => FakeWebSocket.instances.length === 1);
  const socket = FakeWebSocket.latest;
  emitFrame(socket, ready());
  socket.emit("close", { code: 4409, reason: "replaced" });
  await expect(running).rejects.toThrow("4409");

  expect(tickets()).toBe(1);
  expect(String(errors[0])).toContain("4409");
});

it.each([1011, 1012, 4408])(
  "reconnects with a fresh ticket after transient close code %s",
  async (code) => {
    const controller = new AbortController();
    const { client, tickets } = clientWithTickets();
    const running = client.websocket.run({
      signal: controller.signal,
      WebSocket: FakeWebSocket,
      minReconnectDelayMs: 0,
      maxReconnectDelayMs: 0,
      onEvent: async () => {},
    });
    await waitFor(() => FakeWebSocket.instances.length === 1);
    const first = FakeWebSocket.latest;
    emitFrame(first, ready());
    first.emit("close", { code, reason: "transient" });
    await waitFor(() => FakeWebSocket.instances.length === 2);
    expect(tickets()).toBe(2);
    controller.abort();
    await running;
  },
);

it("stops after a non-retryable error frame", async () => {
  const errors: unknown[] = [];
  const { client, tickets } = clientWithTickets();
  const running = client.websocket.run({
    WebSocket: FakeWebSocket,
    minReconnectDelayMs: 0,
    maxReconnectDelayMs: 0,
    onEvent: async () => {},
    onError(error) {
      errors.push(error);
    },
  });
  await waitFor(() => FakeWebSocket.instances.length === 1);
  emitFrame(FakeWebSocket.latest, ready());
  emitFrame(FakeWebSocket.latest, {
    type: "error",
    code: "stale_connection",
    message: "This connection was replaced.",
    fatal: true,
    retryable: false,
  });
  await expect(running).rejects.toThrow("replaced");

  expect(tickets()).toBe(1);
  expect(errors).toHaveLength(1);
  expect(String(errors[0])).toContain("replaced");
});

it.each(["ack_failed", "delivery_failed"] as const)(
  "reconnects after retryable %s even when the frame is fatal to the connection",
  async (code) => {
    const controller = new AbortController();
    const errors: unknown[] = [];
    const { client, tickets } = clientWithTickets();
    const running = client.websocket.run({
      signal: controller.signal,
      WebSocket: FakeWebSocket,
      minReconnectDelayMs: 0,
      maxReconnectDelayMs: 0,
      onEvent: async () => {},
      onError(error) {
        errors.push(error);
      },
    });
    await waitFor(() => FakeWebSocket.instances.length === 1);
    emitFrame(FakeWebSocket.latest, ready());
    emitFrame(FakeWebSocket.latest, {
      type: "error",
      code,
      message: `${code} transient`,
      fatal: true,
      retryable: true,
    });
    await waitFor(() => FakeWebSocket.instances.length === 2);

    expect(tickets()).toBe(2);
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain("transient");
    controller.abort();
    await running;
  },
);

it("rejects an event before ready as a terminal protocol error", async () => {
  const errors: unknown[] = [];
  const { client, tickets } = clientWithTickets();
  const running = client.websocket.run({
    WebSocket: FakeWebSocket,
    minReconnectDelayMs: 0,
    maxReconnectDelayMs: 0,
    onEvent: async () => {},
    onError(error) {
      errors.push(error);
    },
  });
  await waitFor(() => FakeWebSocket.instances.length === 1);
  const socket = FakeWebSocket.latest;
  emitFrame(socket, eventFrame("1"));
  await expect(running).rejects.toThrow("before the ready");

  expect(tickets()).toBe(1);
  expect(errors).toHaveLength(1);
  expect(socket.closeCalls[0]).toEqual({
    code: 4002,
    reason: "protocol error",
  });
});

it("rejects an error code outside the canonical closed union", async () => {
  const { client, tickets } = clientWithTickets();
  const running = client.websocket.run({
    WebSocket: FakeWebSocket,
    minReconnectDelayMs: 0,
    maxReconnectDelayMs: 0,
    onEvent: async () => {},
  });
  await waitFor(() => FakeWebSocket.instances.length === 1);
  const socket = FakeWebSocket.latest;
  emitFrame(socket, ready());
  emitFrame(socket, {
    type: "error",
    code: "unknown",
    message: "not in Relay v1",
    fatal: true,
    retryable: false,
  });
  await expect(running).rejects.toThrow("invalid error frame");
  expect(tickets()).toBe(1);
  expect(socket.closeCalls[0]).toEqual({
    code: 4002,
    reason: "protocol error",
  });
});

it("enforces contiguous decimal sequences without Number precision loss", async () => {
  const errors: unknown[] = [];
  const received: string[] = [];
  const { client } = clientWithTickets();
  const running = client.websocket.run({
    WebSocket: FakeWebSocket,
    minReconnectDelayMs: 0,
    maxReconnectDelayMs: 0,
    onEvent: async (_event, context) => {
      received.push(context.sequence);
    },
    onError(error) {
      errors.push(error);
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
  expect(errors).toHaveLength(1);
  expect(socket.sent.map((value) => JSON.parse(value))).toEqual([{
    type: "ack",
    through_sequence: "9007199254740993",
  }]);
  expect(socket.closeCalls.at(-1)).toEqual({
    code: 4002,
    reason: "protocol error",
  });
});

it("deduplicates replay by event_id in the durable callback and ACKs the replay", async () => {
  const controller = new AbortController();
  const stored = new Set<string>();
  let callbacks = 0;
  const { client, tickets } = clientWithTickets();
  const running = client.websocket.run({
    signal: controller.signal,
    WebSocket: FakeWebSocket,
    minReconnectDelayMs: 0,
    maxReconnectDelayMs: 0,
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

  expect(tickets()).toBe(2);
  expect(callbacks).toBe(2);
  expect(stored).toEqual(new Set([envelope().event_id]));
  expect(replay.sent.map((value) => JSON.parse(value))).toEqual([{
    type: "ack",
    through_sequence: "1",
  }]);

  controller.abort();
  await running;
});

it("stops when ticket creation returns a non-retryable API error", async () => {
  const errors: unknown[] = [];
  let attempts = 0;
  await expect(runWebSocket(
    async () => {
      attempts += 1;
      throw new RelayAPIError("revoked", { status: 401 });
    },
    {
      WebSocket: FakeWebSocket,
      onEvent: async () => {},
      onError(error) {
        errors.push(error);
      },
    },
  )).rejects.toBeInstanceOf(RelayAPIError);
  expect(attempts).toBe(1);
  expect(errors).toHaveLength(1);
});

it("stops on a connection ticket outside the canonical schema", async () => {
  const errors: unknown[] = [];
  let attempts = 0;
  await expect(runWebSocket(
    async () => {
      attempts += 1;
      return {
        url: "https://relay.test/not-a-websocket",
        expires_at: "not-a-date",
        subprotocol: "relay.v1.json",
      };
    },
    {
      WebSocket: FakeWebSocket,
      onEvent: async () => {},
      onError(error) {
        errors.push(error);
      },
    },
  )).rejects.toThrow("invalid WebSocket connection ticket");
  expect(attempts).toBe(1);
  expect(errors).toHaveLength(1);
  expect(String(errors[0])).toContain("invalid WebSocket connection ticket");
  expect(FakeWebSocket.instances).toHaveLength(0);
});

it("rejects invalid reconnect delay options before requesting a ticket", async () => {
  let attempts = 0;
  await expect(runWebSocket(
    async () => {
      attempts += 1;
      throw new Error("not reached");
    },
    {
      WebSocket: FakeWebSocket,
      minReconnectDelayMs: 10,
      maxReconnectDelayMs: 5,
      onEvent: async () => {},
    },
  )).rejects.toThrow(RangeError);
  expect(attempts).toBe(0);
});
