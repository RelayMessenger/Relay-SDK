import { expect, it } from "vitest";
import Relay, { type WebSocketLike } from "../src/index.js";

class FakeWebSocket implements WebSocketLike {
  static latest: FakeWebSocket | undefined;
  readonly listeners = new Map<string, Set<(event: any) => void>>();
  readonly sent: string[] = [];

  constructor(
    readonly url: string,
    readonly protocol?: string | string[],
  ) {
    FakeWebSocket.latest = this;
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
    this.sent.push(data);
  }

  close(): void {
    queueMicrotask(() => this.emit("close", {}));
  }

  emit(type: string, event: any): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const turn = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

it("ACKs only after the durable event callback resolves", async () => {
  const controller = new AbortController();
  let commit: (() => void) | undefined;
  const durable = new Promise<void>((resolve) => {
    commit = resolve;
  });
  const received: string[] = [];
  const client = new Relay({
    apiKey: "agent-token",
    fetch: async (input) => {
      expect(new URL(input instanceof Request ? input.url : input).pathname)
        .toBe("/v1/socket-connections");
      return Response.json({
        url: "wss://relay.test/v1/socket?ticket=one-use",
        expires_at: "2026-08-29T06:30:00.000Z",
        subprotocol: "relay.v1.json",
      });
    },
  });

  const running = client.socketMode.run({
    signal: controller.signal,
    WebSocket: FakeWebSocket,
    minReconnectDelayMs: 1,
    maxReconnectDelayMs: 1,
    onEvent: async (event) => {
      received.push(event.event_id);
      await durable;
    },
  });
  await turn();
  const socket = FakeWebSocket.latest!;
  socket.emit("message", {
    data: JSON.stringify({
      type: "ready",
      connection_id: "01993d50-ef7b-7b37-886b-23fd80c7ec10",
      acked_through: "0",
      heartbeat_interval_ms: 30_000,
      max_in_flight: 64,
    }),
  });
  socket.emit("message", {
    data: JSON.stringify({
      type: "event",
      sequence: "1",
      event: {
        api_version: "v1",
        webhook_version: "2026-02-03",
        event_type: "message.received",
        event_id: "01993d50-ef7b-7b37-886b-23fd80c7ec11",
        created_at: "2026-08-29T06:20:00.000Z",
        trace_id: "trace",
        agent_id: "01993d50-d2a8-7fe2-8b76-9eaf04816377",
        data: {},
      },
    }),
  });
  await turn();
  expect(received).toEqual([
    "01993d50-ef7b-7b37-886b-23fd80c7ec11",
  ]);
  expect(socket.sent).toEqual([]);

  commit!();
  await turn();
  expect(socket.sent.map((value) => JSON.parse(value))).toEqual([{
    type: "ack",
    through_sequence: "1",
  }]);

  controller.abort();
  await running;
});
