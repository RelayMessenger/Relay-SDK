import { expect, it } from "vitest";
import type { CallRoom, CallRoomStateFrame, Relay } from "@relaymessenger/sdk";
import { VISEMES, type RelayAudioSourceLike, type RelayPeerConnectionLike, type RelayWebRTCFactory } from "@relaymessenger/sdk/calls";
import { ElevenLabsCall, getSignedUrl, type ElevenLabsSocket } from "../src/index.js";

/** Call room stand-in: records frames, answers the publish offer, emits what tests push. */
class FakeRoom {
  readonly listeners = new Map<string, Set<(...args: any[]) => void>>();
  iceServers = [{ urls: ["stun:stun.cloudflare.com:3478"] }];
  state: CallRoomStateFrame | null = null;
  readonly sent: Array<{ type: string } & Record<string, unknown>> = [];
  async connect(): Promise<void> {}
  send(frame: { type: string }): void {
    this.sent.push(structuredClone(frame) as { type: string });
    if (frame.type === "offer") queueMicrotask(() => this.emit("answer", { type: "answer", session_description: { type: "answer", sdp: "answer" } }));
  }
  connected(): void { this.send({ type: "connected" }); }
  userUpdate(): void {}
  end(): void { this.send({ type: "end" }); }
  close(): void {}
  on(event: string, listener: (...args: any[]) => void): this {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener);
    this.listeners.set(event, set);
    return this;
  }
  off(event: string, listener: (...args: any[]) => void): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }
  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

class FakeChannel {
  readyState = "connecting";
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  readonly sent: string[] = [];
  send(data: string): void { this.sent.push(data); }
  close(): void { this.readyState = "closed"; }
}

class FakePeer {
  connectionState = "new";
  iceGatheringState = "complete";
  signalingState = "stable";
  localDescription: RTCSessionDescription | null = null;
  remoteDescription: RTCSessionDescription | null = null;
  onconnectionstatechange: (() => void) | null = null;
  ontrack: ((event: { track: { kind: string; stop(): void } }) => void) | null = null;
  readonly channels: FakeChannel[] = [];
  addTransceiver(): { mid: string } { return { mid: "0" }; }
  async createOffer(): Promise<RTCSessionDescriptionInit> { return { type: "offer", sdp: "offer" }; }
  async createAnswer(): Promise<RTCSessionDescriptionInit> { return { type: "answer", sdp: "answer" }; }
  async setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = description as RTCSessionDescription;
    this.signalingState = description.type === "offer" ? "have-local-offer" : "stable";
  }
  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = description as RTCSessionDescription;
    this.signalingState = description.type === "offer" ? "have-remote-offer" : "stable";
    if (description.type === "answer" && this.connectionState !== "connected") {
      this.connectionState = "connected";
      queueMicrotask(() => this.onconnectionstatechange?.());
    }
  }
  createDataChannel(): FakeChannel {
    const channel = new FakeChannel();
    this.channels.push(channel);
    return channel;
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void { this.connectionState = "closed"; }
}

/** The agent's audio source with the werift clock: RTP time sent, plus what is queued. */
class FakeSource implements RelayAudioSourceLike {
  readonly written: Array<{ samples: Int16Array; sampleRate: number }> = [];
  rtpMs = 10_000;
  queued = 0;
  cleared = 0;
  createTrack() { return { kind: "audio", stop() {} }; }
  start(): void {}
  onData(data: { samples: Int16Array; sampleRate: number; channelCount: number }): void {
    this.written.push({ samples: data.samples.slice(), sampleRate: data.sampleRate });
    this.queued += (data.samples.length / data.channelCount / data.sampleRate) * 1_000;
  }
  queuedMs(): number { return this.queued; }
  mediaTimeMs(): number { return this.rtpMs; }
  clear(): void { this.cleared += 1; this.queued = 0; }
}

class FakeWebRTC implements Partial<RelayWebRTCFactory> {
  readonly peer = new FakePeer();
  readonly source = new FakeSource();
  createPeerConnection(): RelayPeerConnectionLike { return this.peer as unknown as RelayPeerConnectionLike; }
  createAudioSource(): RelayAudioSourceLike { return this.source; }
  readonly sinks: Array<{ ondata: ((data: any) => void) | null; stop(): void }> = [];
  readonly sinkFormats: unknown[] = [];
  createAudioSink(_track: unknown, format: unknown) {
    const sink = { ondata: null as ((data: any) => void) | null, stop() {} };
    this.sinks.push(sink);
    this.sinkFormats.push(format);
    return sink;
  }
}

/** ElevenLabs Agents WebSocket stand-in. */
class FakeSocket implements ElevenLabsSocket {
  static last: FakeSocket | undefined;
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code?: number }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readonly sent: Array<Record<string, unknown>> = [];
  closed = false;
  constructor(readonly url: string) {
    FakeSocket.last = this;
    queueMicrotask(() => { this.readyState = 1; this.onopen?.({}); });
  }
  send(data: string): void { this.sent.push(JSON.parse(data) as Record<string, unknown>); }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }
  server(event: Record<string, unknown>): void { this.onmessage?.({ data: JSON.stringify(event) }); }
}

const flush = async (): Promise<void> => {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
};

const pcm = (samples: number[]): string => Buffer.from(new Int16Array(samples).buffer).toString("base64");

const metadata = (input = "pcm_16000", output = "pcm_16000") => ({
  type: "conversation_initiation_metadata",
  conversation_initiation_metadata_event: { conversation_id: "conv_1", user_input_audio_format: input, agent_output_audio_format: output },
});

const personReceives = (room: FakeRoom): void => room.emit("roomState", {
  type: "roomState",
  call: { id: "call", chat_id: "chat", status: "in-progress" },
  participants: [
    { contact_id: "user", kind: "user", attached: true, track: "audio", muted: false, connected: true, tracks: ["audio"], receiving: ["audio"] },
    { contact_id: "agent", kind: "agent", attached: true, track: "audio", muted: false, connected: true, tracks: ["audio", "rive"] },
  ],
});

const start = async (options: { rive?: false } = {}) => {
  const room = new FakeRoom();
  const webRTC = new FakeWebRTC();
  const connecting = ElevenLabsCall.connect({
    relay: {} as Relay,
    callId: "01995bc0-0000-7000-8000-000000000001",
    elevenlabs: { agentId: "agent_1", signedUrl: "wss://api.elevenlabs.io/v1/convai/conversation?agent_id=agent_1&token=t" },
    roomClient: room as unknown as CallRoom,
    webRTC: webRTC as unknown as RelayWebRTCFactory,
    WebSocket: FakeSocket,
    ...options,
  });
  await flush();
  const socket = FakeSocket.last!;
  expect(socket.sent[0]).toEqual({ type: "conversation_initiation_client_data" });
  socket.server(metadata());
  const call = await connecting;
  personReceives(room);
  return { call, room, webRTC, socket };
};

it("joins the call first, then opens the conversation with the signed URL and the initiation data", async () => {
  const { call, socket, room } = await start();
  expect(socket.url).toContain("token=t");
  expect(room.sent.map((frame) => frame.type).slice(0, 3)).toEqual(["offer", "connected", "rive"]);
  expect(call.conversationId).toBe("conv_1");
  call.close();
});

it("streams the caller's PCM to ElevenLabs as base64 user_audio_chunk", async () => {
  const { call, socket, webRTC } = await start();
  // The person's audio track reaches the agent's peer; the transport decodes it through the engine's sink.
  webRTC.peer.ontrack?.({ track: { kind: "audio", stop() {} } });
  const sink = webRTC.sinks[0]!;
  expect(webRTC.sinkFormats[0]).toEqual({ sampleRate: 16_000, channelCount: 1 });
  socket.sent.length = 0;
  const samples = new Int16Array([1, -2, 300]);
  sink.ondata?.({ samples, sampleRate: 16_000, channelCount: 1, bitsPerSample: 16, numberOfFrames: 3 });
  expect(socket.sent).toEqual([{ user_audio_chunk: Buffer.from(samples.buffer).toString("base64") }]);
  call.close();
});

it("plays audio, times alignment visemes against the agent's track, drops interrupted replies, and pongs", async () => {
  const { call, socket, room, webRTC } = await start();
  room.emit("rive", { type: "rive", id: 4 });
  await flush();
  const channel = webRTC.peer.channels[0]!;
  channel.readyState = "open";
  channel.onopen?.();
  await flush();
  expect(call.rive).toBeDefined();

  // 320 samples at 16 kHz = 20 ms; "ma" aligned at 0 and 10 ms.
  socket.server({
    type: "audio",
    audio_event: {
      audio_base_64: pcm(new Array(320).fill(7)),
      event_id: 1,
      alignment: { chars: ["m", "a"], char_start_times_ms: [0, 10], char_durations_ms: [10, 10] },
      is_final: true,
    },
  });
  await flush();
  expect(webRTC.source.written[0]?.sampleRate).toBe(16_000);
  expect(webRTC.source.written.reduce((sum, frame) => sum + frame.samples.length, 0)).toBe(320);
  const messages = channel.sent.map((text) => JSON.parse(text) as { t?: number; view_model?: Record<string, unknown> });
  expect(messages).toEqual([
    { t: 10_000, view_model: { speaking: true } },
    { t: 10_000, view_model: { viseme: VISEMES.indexOf("MBP") } },
    { t: 10_010, view_model: { viseme: VISEMES.indexOf("AI") } },
    { t: 10_020, view_model: { viseme: 0 } },
    { t: 10_020, view_model: { speaking: false } },
  ]);

  socket.server({ type: "interruption", interruption_event: { event_id: 5 } });
  expect(webRTC.source.cleared).toBe(1);
  const written = webRTC.source.written.length;
  socket.server({ type: "audio", audio_event: { audio_base_64: pcm([1, 2]), event_id: 5 } });
  await flush();
  expect(webRTC.source.written).toHaveLength(written);

  socket.server({ type: "ping", ping_event: { event_id: 9, ping_ms: 40 } });
  expect(socket.sent.at(-1)).toEqual({ type: "pong", event_id: 9 });
  call.close();
});

it("ends the Relay Call when ElevenLabs closes the conversation", async () => {
  const { call, socket, room } = await start({ rive: false });
  socket.close();
  await call.closed;
  expect(room.sent.at(-1)).toEqual({ type: "end" });
  expect(room.sent.some((frame) => frame.type === "rive")).toBe(false);
});

it("refuses an agent whose audio formats the call cannot carry, and leaves the call", async () => {
  const room = new FakeRoom();
  const connecting = ElevenLabsCall.connect({
    relay: {} as Relay,
    callId: "01995bc0-0000-7000-8000-000000000001",
    elevenlabs: { agentId: "agent_1", signedUrl: "wss://example" },
    roomClient: room as unknown as CallRoom,
    webRTC: new FakeWebRTC() as unknown as RelayWebRTCFactory,
    WebSocket: FakeSocket,
  });
  await flush();
  FakeSocket.last!.server(metadata("pcm_16000", "pcm_22050"));
  await expect(connecting).rejects.toThrow(/pcm_22050/u);
});

it("mints a signed URL with the API key header and never puts the key in the URL", async () => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const url = await getSignedUrl({
    apiKey: "xi-test",
    agentId: "agent_1",
    fetch: (async (input: URL, init: RequestInit) => {
      calls.push({ url: String(input), headers: init.headers as Record<string, string> });
      return new Response(JSON.stringify({ signed_url: "wss://api.elevenlabs.io/v1/convai/conversation?agent_id=agent_1&token=abc" }));
    }) as unknown as typeof fetch,
  });
  expect(url).toContain("token=abc");
  expect(calls).toEqual([{ url: "https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=agent_1", headers: { "xi-api-key": "xi-test" } }]);
  await expect(getSignedUrl({
    apiKey: "bad",
    agentId: "agent_1",
    fetch: (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch,
  })).rejects.toThrow(/HTTP 401/u);
});
