import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Relay, {
  type Call,
  type CallRoomReconnectingEvent,
  type CallRoomServerFrame,
  type WebSocketLike,
} from "../src/index.js";

// PROTOCOL.md section 5: PartySocket's reconnect numbers and Orange's heartbeat.

class FakeWebSocket implements WebSocketLike {
  static readonly instances: FakeWebSocket[] = [];
  readonly listeners = new Map<string, Set<(event: any) => void>>();
  readonly sent: string[] = [];
  readonly closeCalls: Array<{ code?: number; reason?: string }> = [];

  constructor(readonly url: string, readonly options?: { headers?: Record<string, string> }) {
    FakeWebSocket.instances.push(this);
  }

  static get latest(): FakeWebSocket {
    const socket = FakeWebSocket.instances.at(-1);
    if (!socket) throw new Error("No fake Call room socket exists.");
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

  send(data: string): void { this.sent.push(data); }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    queueMicrotask(() => this.emit("close", { code: code ?? 1000, reason: reason ?? "", wasClean: true }));
  }

  emit(type: string, event: any): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }

  open(): void { this.emit("open", {}); }
  /** The network died: no close frame, the client sees 1006. */
  drop(): void { this.emit("close", { code: 1006, reason: "", wasClean: false }); }
  /** The handshake failed before open (ws: error, then close 1006). */
  fail(): void {
    this.emit("error", { message: "Unexpected server response: 502" });
    this.emit("close", { code: 1006, reason: "", wasClean: false });
  }
  serverClose(code: number, reason: string): void { this.emit("close", { code, reason, wasClean: true }); }
  message(frame: unknown): void { this.emit("message", { data: JSON.stringify(frame) }); }
  frames(): unknown[] { return this.sent.map((data) => JSON.parse(data)); }
}

const call: Call = {
  id: "01995bc0-0000-7000-8000-000000000001",
  chat_id: "01995bc0-0000-7000-8000-000000000002",
  from: { id: "01995bc0-0000-7000-8000-000000000003", handle: "alice", kind: "user" },
  to: [{ id: "01995bc0-0000-7000-8000-000000000004", handle: "echo", kind: "agent" }],
  status: "in-progress",
  revision: 2,
  created_at: "2026-09-22T07:00:00Z",
  ringing_at: "2026-09-22T07:00:00Z",
  answered_at: "2026-09-22T07:00:01Z",
  ended_at: null,
};

const roomState = (status: Call["status"]): CallRoomServerFrame => ({
  type: "roomState",
  call: { ...call, status },
  participants: [
    { contact_id: call.from.id, kind: "user", attached: true, track: "audio", muted: false, connected: true },
    { contact_id: call.to[0].id, kind: "agent", attached: true, track: "audio", muted: false, connected: true },
  ],
});

const offer = {
  type: "offer" as const,
  session_description: { type: "offer" as const, sdp: "v=0\r\n" },
  tracks: [{ mid: "0", name: "audio" as const }],
};

beforeEach(() => {
  FakeWebSocket.instances.length = 0;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const makeRoom = (options: { heartbeatIntervalMs?: number } = {}) => {
  const room = new Relay({ apiKey: "token" }).calls.room(call.id, {
    WebSocket: FakeWebSocket,
    heartbeatIntervalMs: options.heartbeatIntervalMs ?? 60_000,
  });
  const reconnecting: CallRoomReconnectingEvent[] = [];
  const closes: number[] = [];
  const errors: unknown[] = [];
  room.on("reconnecting", (event) => reconnecting.push(event));
  room.on("close", (event) => closes.push(event.code));
  room.on("error", (error) => errors.push(error));
  return { room, reconnecting, closes, errors };
};

const openRoom = async (room: ReturnType<typeof makeRoom>["room"]): Promise<FakeWebSocket> => {
  const connected = room.connect();
  const socket = FakeWebSocket.latest;
  socket.open();
  await connected;
  return socket;
};

it("reopens after an unrequested close with 3000 ms, x1.3, capped at 10000 ms, no retry limit", async () => {
  const { room, reconnecting, closes, errors } = makeRoom();
  const first = await openRoom(room);

  first.drop();
  expect(room.connectionState).toBe("reconnecting");
  expect(closes).toEqual([]);
  expect(errors).toEqual([]);
  expect(reconnecting[0]).toMatchObject({ attempt: 1, delayMs: 3_000, close: { code: 1006, wasClean: false } });

  await vi.advanceTimersByTimeAsync(2_999);
  expect(FakeWebSocket.instances).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(FakeWebSocket.instances).toHaveLength(2);

  // Every later attempt fails before open; the delay grows and caps.
  for (let attempt = 2; attempt <= 9; attempt += 1) {
    FakeWebSocket.latest.fail();
    const delay = reconnecting.at(-1)!.delayMs;
    await vi.advanceTimersByTimeAsync(delay);
    expect(FakeWebSocket.instances).toHaveLength(attempt + 1);
  }
  const delays = reconnecting.map((event) => Math.round(event.delayMs * 10) / 10);
  expect(delays).toEqual([3_000, 3_900, 5_070, 6_591, 8_568.3, 10_000, 10_000, 10_000, 10_000]);
  expect(reconnecting[1]?.error?.message).toMatch(/failed to connect/u);
  expect(closes).toEqual([]);
  expect(errors).toEqual([]);

  FakeWebSocket.latest.open();
  expect(room.connectionState).toBe("open");
  room.close();
});

it("times a connect attempt out after 4000 ms and retries", async () => {
  const { room, reconnecting } = makeRoom();
  const first = await openRoom(room);
  first.drop();
  await vi.advanceTimersByTimeAsync(3_000);
  const stuck = FakeWebSocket.latest;
  await vi.advanceTimersByTimeAsync(3_999);
  expect(reconnecting).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(reconnecting[1]).toMatchObject({ attempt: 2, delayMs: 3_900 });
  expect(reconnecting[1]?.error?.message).toMatch(/timed out/u);
  expect(stuck.closeCalls).toEqual([{ code: 1000, reason: "timeout" }]);
  // The abandoned socket's late open is ignored.
  stuck.open();
  expect(room.connectionState).toBe("reconnecting");
  room.close();
});

it("resets the retry count only after a socket stays open 5000 ms", async () => {
  const { room, reconnecting } = makeRoom();
  const first = await openRoom(room);
  first.drop();
  await vi.advanceTimersByTimeAsync(3_000);
  FakeWebSocket.latest.open();
  await vi.advanceTimersByTimeAsync(4_999);
  FakeWebSocket.latest.drop();
  expect(reconnecting.at(-1)?.delayMs).toBe(3_900);

  await vi.advanceTimersByTimeAsync(3_900);
  FakeWebSocket.latest.open();
  await vi.advanceTimersByTimeAsync(5_000);
  FakeWebSocket.latest.drop();
  expect(reconnecting.at(-1)).toMatchObject({ attempt: 1, delayMs: 3_000 });
  room.close();
});

it("retries a failed first connect and resolves connect() on the first open", async () => {
  const { room, reconnecting } = makeRoom();
  let resolved = false;
  const connected = room.connect().then(() => { resolved = true; });
  FakeWebSocket.latest.fail();
  expect(reconnecting[0]).toMatchObject({ attempt: 1, delayMs: 3_000 });
  expect(room.connectionState).toBe("reconnecting");
  await vi.advanceTimersByTimeAsync(3_000);
  expect(resolved).toBe(false);
  FakeWebSocket.latest.open();
  await connected;
  expect(FakeWebSocket.latest.frames()).toEqual([{ type: "join" }]);
  room.close();
});

it.each([
  [1000, "Replaced"],
  [1000, "Call ended"],
  [4400, "invalid frame"],
])("never reopens after the server closes with %i %s", async (code, reason) => {
  const { room, reconnecting, closes } = makeRoom();
  const socket = await openRoom(room);
  socket.serverClose(code, reason);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(FakeWebSocket.instances).toHaveLength(1);
  expect(reconnecting).toEqual([]);
  expect(closes).toEqual([code]);
  expect(room.connectionState).toBe("idle");
  expect(() => room.connected()).toThrow(/not connected/u);
});

it("never reopens once the Call is over (ended frame or terminal roomState)", async () => {
  const ended = makeRoom();
  const first = await openRoom(ended.room);
  first.message({ type: "ended", reason: "completed" });
  await vi.advanceTimersByTimeAsync(0);
  first.drop();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(FakeWebSocket.instances).toHaveLength(1);
  expect(ended.closes).toEqual([1006]);

  const terminal = makeRoom();
  const second = await openRoom(terminal.room);
  second.message(roomState("failed"));
  await vi.advanceTimersByTimeAsync(0);
  second.drop();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(FakeWebSocket.instances).toHaveLength(2);
  expect(terminal.closes).toEqual([1006]);
});

it("keeps reopening while the Call is ringing or in progress", async () => {
  for (const status of ["ringing", "in-progress"] as const) {
    FakeWebSocket.instances.length = 0;
    const { room } = makeRoom();
    const socket = await openRoom(room);
    socket.message(roomState(status));
    await vi.advanceTimersByTimeAsync(0);
    socket.drop();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
    room.close();
  }
});

it("on reopen sends join, then userUpdate with current muted/video, then the queue; never the offer", async () => {
  const { room } = makeRoom();
  const first = await openRoom(room);
  room.send(offer);
  room.userUpdate({ muted: true, video: true });
  room.userUpdate({ muted: false });
  first.drop();

  // While closed: frames queue, heartbeats drop, userUpdate is recorded.
  room.send({ type: "answer", session_description: { type: "answer", sdp: "v=0\r\n" } });
  room.connected();
  room.send({ type: "heartbeat" });
  room.userUpdate({ muted: true });
  expect(first.sent).toHaveLength(4);

  await vi.advanceTimersByTimeAsync(3_000);
  const second = FakeWebSocket.latest;
  expect(second.sent).toEqual([]);
  second.open();
  expect(second.frames()).toEqual([
    { type: "join" },
    { type: "userUpdate", muted: true, video: true },
    { type: "answer", session_description: { type: "answer", sdp: "v=0\r\n" } },
    { type: "connected" },
  ]);
  expect(second.frames().some((frame: any) => frame.type === "offer")).toBe(false);

  // The queue is sent once.
  second.drop();
  await vi.advanceTimersByTimeAsync(3_900);
  FakeWebSocket.latest.open();
  expect(FakeWebSocket.latest.frames()).toEqual([
    { type: "join" },
    { type: "userUpdate", muted: true, video: true },
  ]);
  room.close();
});

it("sends a heartbeat every 5000 ms by default and none while closed", async () => {
  const room = new Relay({ apiKey: "token" }).calls.room(call.id, { WebSocket: FakeWebSocket });
  const connected = room.connect();
  const socket = FakeWebSocket.latest;
  socket.open();
  await connected;
  await vi.advanceTimersByTimeAsync(4_999);
  expect(socket.frames()).toEqual([{ type: "join" }]);
  await vi.advanceTimersByTimeAsync(1);
  expect(socket.frames()).toEqual([{ type: "join" }, { type: "heartbeat" }]);
  socket.drop();
  await vi.advanceTimersByTimeAsync(2_999);
  expect(socket.frames()).toHaveLength(2);
  room.close();
});

it("close() during a wait stops reopening and rejects connect()", async () => {
  const { room } = makeRoom();
  const pending = room.connect();
  FakeWebSocket.latest.fail();
  room.close();
  await expect(pending).rejects.toThrow(/closed/u);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(FakeWebSocket.instances).toHaveLength(1);
  expect(room.connectionState).toBe("closed");
});

it("manual reconnect uses the same path: immediate, retry count reset, old socket closed as Replaced", async () => {
  const { room, reconnecting, closes } = makeRoom();
  const first = await openRoom(room);
  const replacing = room.reconnect();
  const second = FakeWebSocket.latest;
  expect(second).not.toBe(first);
  // Relay closes the replaced socket as soon as it accepts the new one.
  first.serverClose(1000, "Replaced");
  room.send({ type: "connected" });
  second.open();
  await replacing;
  expect(second.frames()).toEqual([{ type: "join" }, { type: "connected" }]);
  expect(closes).toEqual([]);
  expect(reconnecting).toEqual([]);
  expect(room.connectionState).toBe("open");

  // Reconnect during a wait skips the delay.
  second.drop();
  expect(reconnecting.at(-1)?.delayMs).toBe(3_000);
  const now = room.reconnect();
  expect(FakeWebSocket.instances).toHaveLength(3);
  FakeWebSocket.latest.open();
  await now;
  room.close();
});

it("manual reconnect keeps the old open socket when the new one fails", async () => {
  const { room } = makeRoom();
  const first = await openRoom(room);
  const replacing = room.reconnect();
  room.send({ type: "connected" });
  FakeWebSocket.latest.fail();
  await expect(replacing).rejects.toThrow(/failed to connect/u);
  expect(room.connectionState).toBe("open");
  expect(first.frames()).toEqual([{ type: "join" }, { type: "connected" }]);
  room.end();
  expect(first.frames().at(-1)).toEqual({ type: "end" });
  room.close();
});
