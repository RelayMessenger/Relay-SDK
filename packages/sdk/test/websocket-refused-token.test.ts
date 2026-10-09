import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { RelayAPIError, runWebSocket, type WebSocketLike } from "../src/index.js";

// A refused Agent Token is refused on every attempt, so the run ends with one
// error instead of reconnecting (Discord gateway close 4004; python-telegram-bot
// InvalidToken). Network failures, 5xx and 429 still reconnect.

const listen = async (
  onUpgrade: (socket: Duplex) => void,
): Promise<{ server: Server; baseURL: string }> => {
  const server = createServer();
  server.on("upgrade", (_request, socket) => {
    // The client may drop a refused upgrade before the server finishes writing.
    socket.on("error", () => {});
    onUpgrade(socket);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP test server.");
  return { server, baseURL: `http://127.0.0.1:${address.port}` };
};

const answer = (socket: Duplex, status: string, body: string, headers: string[] = []): void => {
  socket.end([
    `HTTP/1.1 ${status}`,
    "Content-Type: application/json",
    `Content-Length: ${Buffer.byteLength(body)}`,
    ...headers,
    "Connection: close",
    "",
    body,
  ].join("\r\n"));
};

const close = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));

const handlers = { onEvent: async () => {}, onFullSync: async () => {} };

/** Settles with the run's outcome, or "reconnected" once it opens `count` connections. */
const outcome = async (
  running: Promise<void>,
  reconnected: () => boolean,
): Promise<unknown> => {
  const watch = (async () => {
    for (let tick = 0; tick < 200; tick += 1) {
      if (reconnected()) return "reconnected";
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return "timed out";
  })();
  return Promise.race([running.then(() => "resolved", (error: unknown) => error), watch]);
};

const expectRefused = (error: unknown): void => {
  expect(error).toBeInstanceOf(RelayAPIError);
  expect(error).toMatchObject({ status: 401, code: 2004, retryable: false });
  expect(String(error)).toContain("invalid or was revoked");
  expect(String(error)).toContain("Create a new Agent Token");
};

it("stops after one HTTP 401 upgrade and rejects with a typed, final error", async () => {
  let upgrades = 0;
  const { server, baseURL } = await listen((socket) => {
    upgrades += 1;
    answer(socket, "401 Unauthorized", JSON.stringify({
      error: { status: 401, code: 2004, message: "Bearer authentication is required." },
      success: false,
      trace_id: "trace-refused",
    }));
  });
  const controller = new AbortController();
  const errors: unknown[] = [];
  const running = runWebSocket(baseURL, "revoked-token", {
    ...handlers,
    signal: controller.signal,
    minReconnectDelayMs: 0,
    maxReconnectDelayMs: 0,
    onError: (error) => errors.push(error),
  });

  const result = await outcome(running, () => upgrades >= 3);
  controller.abort();
  await running.catch(() => undefined);
  await close(server);

  expectRefused(result);
  expect(result).toMatchObject({ traceId: "trace-refused" });
  expect(upgrades).toBe(1);
  expect(errors).toHaveLength(1);
});

it("keeps reconnecting after an HTTP 503 upgrade", async () => {
  let upgrades = 0;
  const { server, baseURL } = await listen((socket) => {
    upgrades += 1;
    answer(socket, "503 Service Unavailable", JSON.stringify({ error: { status: 503, message: "busy" } }));
  });
  const controller = new AbortController();
  const running = runWebSocket(baseURL, "agent-token", {
    ...handlers,
    signal: controller.signal,
    minReconnectDelayMs: 0,
    maxReconnectDelayMs: 0,
    onError: () => {},
  });

  const result = await outcome(running, () => upgrades >= 3);
  controller.abort();
  await running;
  await close(server);

  expect(result).toBe("reconnected");
});

it("waits for Retry-After before reconnecting after an HTTP 429 upgrade", async () => {
  const at: number[] = [];
  const { server, baseURL } = await listen((socket) => {
    at.push(Date.now());
    answer(socket, "429 Too Many Requests", JSON.stringify({ error: { status: 429, message: "slow down" } }), ["Retry-After: 1"]);
  });
  const controller = new AbortController();
  const running = runWebSocket(baseURL, "agent-token", {
    ...handlers,
    signal: controller.signal,
    minReconnectDelayMs: 0,
    maxReconnectDelayMs: 0,
    onError: () => {},
  });

  for (let tick = 0; tick < 400 && at.length < 2; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  controller.abort();
  await running;
  await close(server);

  expect(at.length).toBeGreaterThanOrEqual(2);
  expect(at[1]! - at[0]!).toBeGreaterThanOrEqual(950);
});

/** A WebSocket with no `unexpected-response` (Bun, Deno, browsers): every failed upgrade is a bare 1006 close. */
class StatuslessWebSocket implements WebSocketLike {
  static readonly instances: StatuslessWebSocket[] = [];
  static frames: unknown[] = [];
  readonly listeners = new Map<string, Set<(event: any) => void>>();

  constructor(readonly url: string) {
    StatuslessWebSocket.instances.push(this);
    queueMicrotask(() => {
      if (StatuslessWebSocket.frames.length === 0) {
        this.emit("error", {});
        this.emit("close", { code: 1006, reason: "" });
        return;
      }
      for (const frame of StatuslessWebSocket.frames) {
        this.emit("message", { data: JSON.stringify(frame) });
      }
    });
  }

  addEventListener(type: string, listener: (event: any) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: any) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(): void {}

  close(code?: number, reason?: string): void {
    queueMicrotask(() => this.emit("close", { code, reason }));
  }

  emit(type: string, event: any): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

beforeEach(() => {
  StatuslessWebSocket.instances.length = 0;
  StatuslessWebSocket.frames = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it("asks GET /v1/me when the WebSocket cannot report the upgrade status, and stops on its 401", async () => {
  const fetched: Array<{ url: string; authorization: string | null }> = [];
  vi.stubGlobal("fetch", async (url: URL, init: RequestInit) => {
    fetched.push({ url: String(url), authorization: new Headers(init.headers).get("authorization") });
    return Response.json({
      error: { status: 401, code: 2004, message: "Bearer authentication is required." },
      success: false,
      trace_id: "trace-me",
    }, { status: 401 });
  });
  const controller = new AbortController();
  const running = runWebSocket("https://relay.test/ignored?x=1", "revoked-token", {
    ...handlers,
    signal: controller.signal,
    WebSocket: StatuslessWebSocket,
    minReconnectDelayMs: 0,
    maxReconnectDelayMs: 0,
    onError: () => {},
  });

  const result = await outcome(running, () => StatuslessWebSocket.instances.length >= 3);
  controller.abort();
  await running.catch(() => undefined);

  expectRefused(result);
  expect(StatuslessWebSocket.instances).toHaveLength(1);
  expect(fetched).toEqual([{ url: "https://relay.test/v1/me", authorization: "Bearer revoked-token" }]);
});

it("keeps reconnecting when GET /v1/me is not a 401", async () => {
  vi.stubGlobal("fetch", async () => new Response("busy", { status: 503 }));
  const controller = new AbortController();
  const running = runWebSocket("https://relay.test", "agent-token", {
    ...handlers,
    signal: controller.signal,
    WebSocket: StatuslessWebSocket,
    minReconnectDelayMs: 0,
    maxReconnectDelayMs: 0,
    onError: () => {},
  });

  const result = await outcome(running, () => StatuslessWebSocket.instances.length >= 3);
  controller.abort();
  await running;

  expect(result).toBe("reconnected");
});

it("stops on a revoked disconnect frame with the same final error", async () => {
  StatuslessWebSocket.frames = [
    {
      type: "ready",
      connection_id: "01993d50-ef7b-7b37-886b-23fd80c7ec10",
      acked_through: "0",
      full_sync_required: false,
      full_sync_through: null,
      heartbeat_interval_ms: 30_000,
      max_in_flight: 64,
    },
    { type: "disconnect", reason: "revoked" },
  ];
  const controller = new AbortController();
  const running = runWebSocket("https://relay.test", "agent-token", {
    ...handlers,
    signal: controller.signal,
    WebSocket: StatuslessWebSocket,
    minReconnectDelayMs: 0,
    maxReconnectDelayMs: 0,
    onError: () => {},
  });

  const result = await outcome(running, () => StatuslessWebSocket.instances.length >= 3);
  controller.abort();
  await running.catch(() => undefined);

  expectRefused(result);
  expect(StatuslessWebSocket.instances).toHaveLength(1);
});
