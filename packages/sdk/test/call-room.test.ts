import { beforeEach, expect, it, vi } from "vitest";
import Relay, {
  parseCallRoomServerFrame,
  type Call,
  type CallRoomErrorFrame,
  type CallRoomServerFrame,
  type WebSocketLike,
} from "../src/index.js";

class FakeWebSocket implements WebSocketLike {
  static readonly instances: FakeWebSocket[] = [];
  readonly listeners = new Map<string, Set<(event: any) => void>>();
  readonly sent: string[] = [];
  readonly closeCalls: Array<{ code?: number; reason?: string }> = [];

  constructor(
    readonly url: string,
    readonly options?: { headers?: Record<string, string> },
  ) {
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

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    queueMicrotask(() => this.emit("close", { code: code ?? 1000, reason: reason ?? "", wasClean: true }));
  }

  emit(type: string, event: any): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  message(frame: unknown): void {
    this.emit("message", { data: JSON.stringify(frame) });
  }
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

const roomState: CallRoomServerFrame = {
  type: "roomState",
  call,
  participants: [
    { contact_id: call.from.id, kind: "user", attached: true, track: "audio", muted: false, connected: true },
    { contact_id: call.to[0].id, kind: "agent", attached: true, track: "audio", muted: false, connected: true },
  ],
};

beforeEach(() => {
  FakeWebSocket.instances.length = 0;
  vi.useRealTimers();
});

const connect = async (room: ReturnType<Relay["calls"]["room"]>): Promise<FakeWebSocket> => {
  const connected = room.connect();
  const socket = FakeWebSocket.latest;
  socket.emit("open", {});
  await connected;
  return socket;
};

it("joins the authenticated signaling room and exposes every stable server frame", async () => {
  const client = new Relay({ apiKey: "agent-token", baseURL: "https://api.staging.relayapp.im/root/" });
  const room = client.calls.room(call.id, { WebSocket: FakeWebSocket, heartbeatIntervalMs: 60_000 });
  const received: string[] = [];
  let serverError: CallRoomErrorFrame | undefined;
  room.on("roomState", () => received.push("roomState"));
  room.on("answer", () => received.push("answer"));
  room.on("offer", () => received.push("offer"));
  room.on("ended", () => received.push("ended"));
  room.on("error", (error) => {
    if (!(error instanceof Error)) serverError = error;
  });

  const socket = await connect(room);
  expect(socket.url).toBe(`wss://api.staging.relayapp.im/root/v1/calls/${call.id}/room`);
  expect(socket.options?.headers).toEqual({ Authorization: "Bearer agent-token" });
  expect(socket.sent.map(JSON.parse)).toEqual([{ type: "join" }]);

  socket.message(roomState);
  socket.message({ type: "answer", session_description: { type: "answer", sdp: "v=0\r\n" } });
  socket.message({ type: "offer", session_description: { type: "offer", sdp: "v=0\r\n" }, track: "audio" });
  socket.message({ type: "heartbeat" });
  socket.message({ type: "error", code: "media_unavailable", message: "Call audio is unavailable." });
  socket.message({ type: "ended", reason: "completed" });
  await Promise.resolve();

  expect(received).toEqual(["roomState", "answer", "offer", "ended"]);
  expect(serverError).toEqual({ type: "error", code: "media_unavailable", message: "Call audio is unavailable." });
  expect(room.state).toEqual(roomState);

  room.connected();
  room.userUpdate({ muted: true });
  room.userUpdate({ muted: false, video: true });
  room.end();
  expect(socket.sent.slice(1).map(JSON.parse)).toEqual([
    { type: "connected" },
    { type: "userUpdate", muted: true },
    { type: "userUpdate", muted: false, video: true },
    { type: "end" },
  ]);
  room.close();
});

it("replaces signaling without dropping the old socket first", async () => {
  const client = new Relay({ apiKey: "token" });
  const room = client.calls.room(call.id, { WebSocket: FakeWebSocket, heartbeatIntervalMs: 60_000 });
  const first = await connect(room);

  const reconnecting = room.reconnect();
  const second = FakeWebSocket.latest;
  expect(second).not.toBe(first);
  expect(first.closeCalls).toEqual([]);
  second.emit("open", {});
  await reconnecting;

  expect(second.sent.map(JSON.parse)).toEqual([{ type: "join" }]);
  expect(first.closeCalls).toEqual([{ code: 1000, reason: "Replaced" }]);
  expect(room.connectionState).toBe("open");
  room.close();
});

it("sends heartbeat frames and closes malformed server frames with 4400", async () => {
  vi.useFakeTimers();
  const client = new Relay({ apiKey: "token" });
  const room = client.calls.room(call.id, { WebSocket: FakeWebSocket, heartbeatIntervalMs: 1_000 });
  const errors: Error[] = [];
  room.on("error", (error) => { if (error instanceof Error) errors.push(error); });
  const socket = await connect(room);

  await vi.advanceTimersByTimeAsync(2_000);
  expect(socket.sent.map(JSON.parse)).toEqual([
    { type: "join" }, { type: "heartbeat" }, { type: "heartbeat" },
  ]);

  socket.message({ type: "offer", session_description: { type: "offer", sdp: "v=0" }, track: "screen" });
  await Promise.resolve();
  await Promise.resolve();
  expect(errors[0]?.message).toMatch(/invalid frame/u);
  expect(socket.closeCalls).toContainEqual({ code: 4400, reason: "invalid frame" });
  room.close();
});

it("accepts the video pull offer and the participant video and track fields", () => {
  const offer = { type: "offer", session_description: { type: "offer", sdp: "v=0\r\n" }, track: "video" };
  expect(parseCallRoomServerFrame(offer)).toEqual(offer);
  const withVideo = {
    ...roomState,
    participants: [
      { ...roomState.participants[0], video: true, tracks: ["audio", "video"] },
      { ...roomState.participants[1], video: false, tracks: ["audio"] },
    ],
  };
  expect(parseCallRoomServerFrame(withVideo)).toEqual(withVideo);
  const drifted = (participant: Record<string, unknown>) => ({
    ...roomState,
    participants: [{ ...roomState.participants[0], ...participant }, roomState.participants[1]],
  });
  expect(() => parseCallRoomServerFrame(drifted({ video: "yes", tracks: ["audio"] }))).toThrow(/invalid frame/u);
  expect(() => parseCallRoomServerFrame(drifted({ video: true, tracks: ["audio", "audio"] }))).toThrow(/invalid frame/u);
  expect(() => parseCallRoomServerFrame(drifted({ video: true, tracks: ["screen"] }))).toThrow(/invalid frame/u);
  expect(() => parseCallRoomServerFrame(drifted({ video: true }))).toThrow(/invalid frame/u);
});

it("parses the roomState staging sent before either participant published (tracks: [])", async () => {
  // Captured from staging (Relay-Server 1241f83d) by the calls test ladder, 2026-09-22.
  const { readFile } = await import("node:fs/promises");
  const frame = JSON.parse(await readFile(
    new URL("./fixtures/staging-roomstate-before-publish.json", import.meta.url),
    "utf8",
  )) as Record<string, any>;
  expect(frame.participants.map((participant: { tracks: unknown }) => participant.tracks)).toEqual([[], []]);
  expect(parseCallRoomServerFrame(frame)).toEqual(frame);
});

it("rejects server frames whose stable shapes drift", () => {
  expect(() => parseCallRoomServerFrame({ ...roomState, extra: true })).toThrow(/invalid frame/u);
  expect(() => parseCallRoomServerFrame({
    type: "roomState",
    call,
    participants: [{ contact_id: call.from.id, kind: "user", attached: true, track: "audio", muted: false, connected: true }],
  })).toThrow(/invalid frame/u);
  expect(() => parseCallRoomServerFrame({ type: "error", code: "cloudflare_error", message: "provider detail" }))
    .toThrow(/invalid frame/u);
});
