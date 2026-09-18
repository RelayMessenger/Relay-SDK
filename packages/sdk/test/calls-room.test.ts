import { afterEach, beforeEach, expect, it } from "vitest";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import Relay, { CallRoom, RelayAPIError, type Call, type CallRoomStateFrame } from "../src/index.js";

const call: Call = {
  id: "01995bc0-0000-7000-8000-000000000001",
  chat_id: "01995bc0-0000-7000-8000-000000000002",
  from: { id: "01995bc0-0000-7000-8000-000000000003", handle: "alice", kind: "user" },
  to: [{ id: "01995bc0-0000-7000-8000-000000000004", handle: "echo", kind: "agent" }],
  mode: "audio",
  status: "ringing",
  revision: 1,
  created_at: "2026-09-18T12:00:00Z",
  ringing_at: "2026-09-18T12:00:00Z",
  answered_at: null,
  connected_at: null,
  ended_at: null,
  end_reason: null,
};

const roomState: CallRoomStateFrame = {
  type: "roomState",
  call,
  participants: [
    { contact_id: call.from.id, kind: "user", attached: true, track: "microphone", muted: false, connected: false },
    { contact_id: call.to[0].id, kind: "agent", attached: true, track: null, muted: false, connected: false },
  ],
  media: {
    url: `wss://api.staging.relayapp.im/v1/calls/${call.id}/media`,
    token: "temporary-media-grant-temporary-media-grant",
    expires_at: "2026-09-18T12:01:00Z",
    audio_format: { encoding: "pcm_s16le", sample_rate: 48000, channels: 2 },
  },
};

const waitFor = async (condition: () => boolean, label: string): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

let server: Server;
let wss: WebSocketServer;
let baseURL: string;
const rooms: Array<{ socket: ServerSocket; authorization: string | undefined; path: string; frames: unknown[] }> = [];

beforeEach(async () => {
  rooms.length = 0;
  server = createServer((_request, response) => { response.writeHead(404); response.end(); });
  wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    if (request.headers.authorization === "Bearer wrong-token") {
      socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\n\r\n"
        + JSON.stringify({ error: { message: "Invalid token." } }));
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      const room = { socket: ws, authorization: request.headers.authorization, path: request.url!, frames: [] as unknown[] };
      rooms.push(room);
      ws.on("message", (raw) => { room.frames.push(JSON.parse(raw.toString())); });
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  baseURL = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  for (const socket of wss.clients) socket.terminate();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const openRoom = async (token = "agent-test-token"): Promise<CallRoom> => {
  const client = new Relay({ apiKey: token, baseURL, retryBaseDelayMs: 0 });
  const room = client.calls.room(call.id, { heartbeatIntervalMs: 20 });
  await waitFor(() => rooms.length === 1 && rooms[0]!.frames.length >= 1, "join");
  return room;
};

it("upgrades with the bearer, sends join first, and mirrors roomState", async () => {
  const room = await openRoom();
  expect(room.url).toBe(`ws://127.0.0.1:${new URL(baseURL).port}/v1/calls/${call.id}/room`);
  expect(rooms[0]!.path).toBe(`/v1/calls/${call.id}/room`);
  expect(rooms[0]!.authorization).toBe("Bearer agent-test-token");
  expect(rooms[0]!.frames[0]).toEqual({ type: "join" });
  expect(room.state).toBeNull();
  const seen: CallRoomStateFrame[] = [];
  room.on("roomState", (frame) => seen.push(frame));
  rooms[0]!.socket.send(JSON.stringify(roomState));
  await waitFor(() => seen.length === 1, "roomState");
  expect(seen[0]).toEqual(roomState);
  expect(room.state).toEqual(roomState);
  expect(room.state?.media?.token).toBe(roomState.media!.token);
  room.close();
});

it("sends the exact action frames and heartbeats until close", async () => {
  const room = await openRoom();
  room.accept();
  room.userUpdate({ muted: true });
  room.connected();
  room.decline();
  room.end();
  room.send({ type: "offer", session_description: { type: "offer", sdp: "v=0\r\n" }, tracks: [{ mid: "0", name: "microphone" }] });
  await waitFor(() => rooms[0]!.frames.some((frame) => (frame as { type: string }).type === "heartbeat"), "heartbeat");
  const nonHeartbeat = rooms[0]!.frames.filter((frame) => (frame as { type: string }).type !== "heartbeat");
  expect(nonHeartbeat).toEqual([
    { type: "join" },
    { type: "accept" },
    { type: "userUpdate", muted: true },
    { type: "connected" },
    { type: "decline" },
    { type: "end" },
    { type: "offer", session_description: { type: "offer", sdp: "v=0\r\n" }, tracks: [{ mid: "0", name: "microphone" }] },
  ]);
  const closed: Array<{ code: number; reason: string }> = [];
  room.on("close", (event) => closed.push(event));
  room.close();
  await waitFor(() => closed.length === 1, "close");
  const heartbeatsAtClose = rooms[0]!.frames.length;
  await new Promise((resolve) => setTimeout(resolve, 80));
  expect(rooms[0]!.frames.length).toBe(heartbeatsAtClose);
  expect(room.closed).toBe(true);
  expect(() => room.accept()).toThrow(/closed/);
});

it("delivers offer and answer frames to their listeners", async () => {
  const room = await openRoom();
  const offers: unknown[] = []; const answers: unknown[] = [];
  room.on("offer", (frame) => offers.push(frame));
  room.on("answer", (frame) => answers.push(frame));
  rooms[0]!.socket.send(JSON.stringify({ type: "answer", session_description: { type: "answer", sdp: "v=0\r\na" } }));
  rooms[0]!.socket.send(JSON.stringify({ type: "offer", session_description: { type: "offer", sdp: "v=0\r\nb" }, track: "agent-voice" }));
  rooms[0]!.socket.send(JSON.stringify({ type: "heartbeat" }));
  await waitFor(() => offers.length === 1 && answers.length === 1, "offer and answer");
  expect(answers[0]).toEqual({ type: "answer", session_description: { type: "answer", sdp: "v=0\r\na" } });
  expect(offers[0]).toEqual({ type: "offer", session_description: { type: "offer", sdp: "v=0\r\nb" }, track: "agent-voice" });
  expect(room.closed).toBe(false);
  room.close();
});

it("fires ended and closes the socket", async () => {
  const room = await openRoom();
  const ended: unknown[] = []; const closed: Array<{ code: number; reason: string }> = [];
  room.on("ended", (frame) => ended.push(frame));
  room.on("close", (event) => closed.push(event));
  const serverClosed = once(rooms[0]!.socket, "close");
  rooms[0]!.socket.send(JSON.stringify({ type: "ended", reason: "completed" }));
  await waitFor(() => closed.length === 1, "close after ended");
  expect(ended).toEqual([{ type: "ended", reason: "completed" }]);
  expect(closed[0]!.code).toBe(1000);
  expect((await serverClosed)[0]).toBe(1000);
  expect(room.closed).toBe(true);
});

it.each([
  ["unknown type", { type: "subscribe" }],
  ["roomState without participants", { type: "roomState", call }],
  ["ended with a foreign reason", { type: "ended", reason: "busy" }],
  ["error with a foreign code", { type: "error", code: "boom", message: "x" }],
  ["not JSON", "not json"],
] as const)("closes 4400 on an invalid frame: %s", async (_label, frame) => {
  const room = await openRoom();
  const errors: unknown[] = [];
  room.on("error", (error) => errors.push(error));
  const serverClosed = once(rooms[0]!.socket, "close");
  rooms[0]!.socket.send(typeof frame === "string" ? frame : JSON.stringify(frame));
  const [code, reason] = await serverClosed as [number, Buffer];
  expect(code).toBe(4400);
  expect(reason.toString()).toBe("invalid frame");
  await waitFor(() => room.closed, "client close");
  expect(errors).toHaveLength(1);
  expect(errors[0]).toBeInstanceOf(Error);
  expect((errors[0] as Error).message).toMatch(/invalid frame/);
});

it("passes a server error frame through without closing", async () => {
  const room = await openRoom();
  const errors: unknown[] = [];
  room.on("error", (error) => errors.push(error));
  rooms[0]!.socket.send(JSON.stringify({ type: "error", code: "not_allowed", message: "Only the callee may accept." }));
  await waitFor(() => errors.length === 1, "error frame");
  expect(errors[0]).toEqual({ type: "error", code: "not_allowed", message: "Only the callee may accept." });
  expect(room.closed).toBe(false);
  room.close();
});

it("surfaces the REST ApiError body when the upgrade is refused", async () => {
  const client = new Relay({ apiKey: "wrong-token", baseURL });
  const room = client.calls.room(call.id);
  const errors: unknown[] = [];
  room.on("error", (error) => errors.push(error));
  await waitFor(() => room.closed, "refused upgrade");
  expect(errors).toHaveLength(1);
  expect(errors[0]).toBeInstanceOf(RelayAPIError);
  expect((errors[0] as RelayAPIError).status).toBe(401);
  expect((errors[0] as RelayAPIError).message).toBe("Invalid token.");
  expect(rooms).toHaveLength(0);
});

it("refuses an empty call id before opening a socket", () => {
  const client = new Relay({ apiKey: "token", baseURL });
  expect(() => client.calls.room(" ")).toThrow(/Call id/);
  expect(rooms).toHaveLength(0);
});
