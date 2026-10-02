import { afterEach, expect, it, vi } from "vitest";
import { Decoder } from "@evan/opus";
import type { MediaStreamTrack, RtpPacket } from "werift";
import type { CallRoom, CallRoomStateFrame, Relay } from "@relaymessenger/sdk";
import { VISEMES, createWeriftWebRTCFactory, type RelayAudioSourceLike, type RelayPeerConnectionLike, type RelayWebRTCFactory } from "@relaymessenger/sdk/calls";
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
  drains = 0;
  createTrack() { return { kind: "audio", stop() {} }; }
  start(): void {}
  onData(data: { samples: Int16Array; sampleRate: number; channelCount: number }): void {
    this.written.push({ samples: data.samples.slice(), sampleRate: data.sampleRate });
    this.queued += (data.samples.length / data.channelCount / data.sampleRate) * 1_000;
  }
  queuedMs(): number { return this.queued; }
  mediaTimeMs(): number { return this.rtpMs; }
  clear(): void { this.cleared += 1; this.queued = 0; }
  async waitForDrain(): Promise<void> { this.drains += 1; }
}

class FakeWebRTC implements Partial<RelayWebRTCFactory> {
  constructor(readonly audioSource?: RelayAudioSourceLike) {}
  readonly peer = new FakePeer();
  readonly source = new FakeSource();
  createPeerConnection(): RelayPeerConnectionLike { return this.peer as unknown as RelayPeerConnectionLike; }
  createAudioSource(): RelayAudioSourceLike { return this.audioSource ?? this.source; }
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

const start = async (options: { rive?: false } = {}, source?: RelayAudioSourceLike, subscribed = true) => {
  const room = new FakeRoom();
  const webRTC = new FakeWebRTC(source);
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
  if (subscribed) personReceives(room);
  return { call, room, webRTC, socket };
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const openRive = async (room: FakeRoom, webRTC: FakeWebRTC) => {
  room.emit("rive", { type: "rive", id: 4 });
  await flush();
  const channel = webRTC.peer.channels[0]!;
  channel.readyState = "open";
  channel.onopen?.();
  await flush();
  return () => channel.sent.map((text) => JSON.parse(text) as { t?: number; view_model?: Record<string, unknown> });
};

it("completes an unmarked reply on agent_response_complete, including its sub-slice tail", async () => {
  const { call, socket, room, webRTC } = await start();
  const sent = await openRive(room, webRTC);
  socket.server({ type: "audio", audio_event: { audio_base_64: pcm(new Array(240).fill(7)), event_id: 1 } });
  socket.server({ type: "agent_response_complete", agent_response_complete_event: { event_id: 1 } });
  await flush();
  expect(webRTC.source.written.flatMap((frame) => [...frame.samples])).toEqual([
    ...new Array(240).fill(7), ...new Array(80).fill(0),
  ]);
  expect(webRTC.source.drains).toBe(1);
  expect(sent().at(-1)).toEqual({ t: 10_020, view_model: { viseme: 0, speaking: false } });
  call.close();
});

it("waits for held audio before handling an empty final marker", async () => {
  const { call, socket, room, webRTC } = await start({}, undefined, false);
  const sent = await openRive(room, webRTC);
  socket.server({ type: "audio", audio_event: { audio_base_64: pcm(new Array(320).fill(7)), event_id: 1 } });
  socket.server({ type: "audio", audio_event: { event_id: 1, is_final: true } });
  await flush();
  expect(webRTC.source.written).toHaveLength(0);
  expect(sent()).toHaveLength(0);
  personReceives(room);
  await flush();
  expect(webRTC.source.drains).toBe(1);
  expect(sent().at(-1)).toEqual({ t: 10_020, view_model: { viseme: 0, speaking: false } });
  call.close();
});

it("rests after queued audio and a quiet timeout without is_final or any completion event", async () => {
  vi.useFakeTimers();
  const { call, socket, room, webRTC } = await start();
  const sent = await openRive(room, webRTC);
  socket.server({ type: "audio", audio_event: { audio_base_64: pcm(new Array(16_000).fill(7)), event_id: 1 } });
  await flush();
  await vi.advanceTimersByTimeAsync(1_249);
  expect(sent().some((message) => message.view_model?.speaking === false)).toBe(false);
  webRTC.source.rtpMs += 1_000;
  webRTC.source.queued = 0;
  await vi.advanceTimersByTimeAsync(1);
  expect(sent().at(-1)).toEqual({ t: 11_000, view_model: { viseme: 0, speaking: false } });
  call.close();
});

it("restarts the quiet timeout on audio, not on text responses or corrections", async () => {
  vi.useFakeTimers();
  const { call, socket, room, webRTC } = await start();
  const sent = await openRive(room, webRTC);
  const audio = { type: "audio", audio_event: { audio_base_64: pcm(new Array(320).fill(7)), event_id: 1 } };
  socket.server({ type: "agent_response", agent_response_event: { agent_response: "Hello", event_id: 1 } });
  socket.server(audio);
  await flush();
  await vi.advanceTimersByTimeAsync(200);
  webRTC.source.rtpMs += 20;
  webRTC.source.queued = 0;
  socket.server(audio);
  socket.server({ type: "agent_response_correction", agent_response_correction_event: { corrected_agent_response: "Hi", event_id: 1 } });
  await flush();
  await vi.advanceTimersByTimeAsync(269);
  expect(sent().some((message) => message.view_model?.speaking === false)).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(sent().at(-1)).toEqual({ t: 10_040, view_model: { viseme: 0, speaking: false } });
  call.close();
});

it("cancels an old reply's timeout on interruption and close", async () => {
  vi.useFakeTimers();
  const { call, socket, room, webRTC } = await start();
  const sent = await openRive(room, webRTC);
  socket.server({ type: "audio", audio_event: { audio_base_64: pcm(new Array(320).fill(7)), event_id: 1 } });
  await flush();
  socket.server({ type: "interruption", interruption_event: { event_id: 1 } });
  socket.server({ type: "audio", audio_event: { audio_base_64: pcm(new Array(16_000).fill(7)), event_id: 2 } });
  socket.server({ type: "agent_response_complete", agent_response_complete_event: { event_id: 1 } });
  await flush();
  const count = sent().length;
  await vi.advanceTimersByTimeAsync(500);
  expect(sent()).toHaveLength(count);
  expect(webRTC.source.drains).toBe(0);
  call.close();
  await vi.advanceTimersByTimeAsync(2_000);
  expect(sent()).toHaveLength(count);
  expect(webRTC.source.drains).toBe(0);
});

it.each(["interruption", "close"] as const)("cancels completion waiting for playout on %s", async (ending) => {
  const { call, socket, room, webRTC } = await start();
  const sent = await openRive(room, webRTC);
  let release!: () => void;
  vi.spyOn(webRTC.source, "waitForDrain").mockReturnValue(new Promise<void>((resolve) => { release = resolve; }));
  socket.server({ type: "audio", audio_event: { audio_base_64: pcm(new Array(320).fill(7)), event_id: 1, is_final: true } });
  await flush();
  expect(sent().some((message) => message.view_model?.speaking === false)).toBe(false);
  if (ending === "close") call.close();
  else {
    socket.server({ type: "interruption", interruption_event: { event_id: 1 } });
    socket.server({ type: "audio", audio_event: { audio_base_64: pcm(new Array(320).fill(7)), event_id: 2 } });
    await flush();
  }
  const count = sent().length;
  release();
  await flush();
  expect(sent()).toHaveLength(count);
  call.close();
});

it("starts and rests consecutive completed replies independently", async () => {
  const { call, socket, room, webRTC } = await start();
  const sent = await openRive(room, webRTC);
  for (const event_id of [1, 2]) {
    socket.server({ type: "audio", audio_event: { audio_base_64: pcm(new Array(320).fill(7)), event_id } });
    socket.server({ type: "agent_response_complete", agent_response_complete_event: { event_id } });
    await flush();
    webRTC.source.rtpMs += 20;
    webRTC.source.queued = 0;
  }
  expect(sent().map((message) => message.view_model?.speaking)).toEqual([true, false, true, false]);
  call.close();
});

it.each(["agent_response_complete", "is_final", "quiet"] as const)(
  "flushes the final 10 ms into a padded Opus packet at %s without waiting for the next reply",
  async (ending) => {
    vi.useFakeTimers();
    const source = createWeriftWebRTCFactory().createAudioSource();
    const track = source.createTrack() as unknown as MediaStreamTrack;
    const packets: Buffer[] = [];
    track.onReceiveRtp.subscribe((rtp: RtpPacket) => packets.push(Buffer.from(rtp.payload)));
    const { call, socket } = await start({ rive: false }, source);
    await vi.advanceTimersByTimeAsync(40);
    socket.server({
      type: "audio",
      audio_event: { audio_base_64: pcm(new Array(160).fill(8_000)), event_id: 1, ...(ending === "is_final" ? { is_final: true } : {}) },
    });
    if (ending === "agent_response_complete") socket.server({ type: ending, agent_response_complete_event: { event_id: 1 } });
    await flush();
    await vi.advanceTimersByTimeAsync(ending === "quiet" ? 300 : 40);
    expect(source.stats!().opusPackets).toBe(1);
    expect(source.stats!().rtpPackets).toBe(1);
    expect(source.queuedMs!()).toBe(0);
    const decoder = new Decoder({ channels: 2, sample_rate: 48_000 });
    const decoded = packets.map((packet) => decoder.decode(packet));
    expect(decoded.every((frame) => frame.byteLength === 960 * 2 * 2)).toBe(true);
    expect(decoded.some((frame) => frame.some((byte) => byte !== 0))).toBe(true);
    call.close();
  },
);

it("rests a quiet reply only after its delayed partial packet reaches RTP", async () => {
  vi.useFakeTimers();
  const source = createWeriftWebRTCFactory().createAudioSource();
  const { call, socket, room, webRTC } = await start({}, source);
  const sent = await openRive(room, webRTC);
  await vi.advanceTimersByTimeAsync(40);
  socket.server({ type: "audio", audio_event: { audio_base_64: pcm(new Array(160).fill(8_000)), event_id: 1 } });
  await flush();
  await vi.advanceTimersByTimeAsync(259);
  expect(source.stats!().rtpPackets).toBe(0);
  expect(sent().some((message) => message.view_model?.speaking === false)).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  if (source.stats!().rtpPackets === 0) {
    expect(sent().some((message) => message.view_model?.speaking === false)).toBe(false);
  }
  await vi.advanceTimersByTimeAsync(40);
  expect(source.stats!().rtpPackets).toBe(1);
  const rest = sent().find((message) => message.view_model?.speaking === false);
  expect(rest?.t).toBeGreaterThanOrEqual(300);
  expect(source.queuedMs!()).toBe(0);
  call.close();
});

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
    { t: 10_020, view_model: { viseme: 0, speaking: false } },
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

it("fails connect and leaves the ElevenLabs session when the caller hangs up while it starts", async () => {
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
  const socket = FakeSocket.last!;
  room.emit("ended", { type: "ended", reason: "completed" });
  await expect(connecting).rejects.toThrow(/ended before the ElevenLabs session started/u);
  expect(socket.closed).toBe(true);
});

it("finishes when the call room closes for good", async () => {
  const { call, room, socket } = await start();
  // The transport re-emits the room's terminal close (for example 1000 "Replaced") as `close`.
  room.emit("close", { code: 1000, reason: "Replaced", wasClean: true });
  await call.closed;
  expect(socket.closed).toBe(true);
  expect(room.sent.at(-1)?.type).not.toBe("end");
});

it("carries partial 10 ms slices between audio events instead of padding gaps", async () => {
  const { call, socket, webRTC } = await start({ rive: false });
  // Five 256-sample chunks at 16 kHz: 80 ms; 10 ms slices are 160 samples.
  for (let index = 0; index < 5; index += 1) {
    socket.server({ type: "audio", audio_event: { audio_base_64: pcm(new Array(256).fill(1)), event_id: 1, is_final: index === 4 } });
  }
  await flush();
  const written = webRTC.source.written.reduce((sum, frame) => sum + frame.samples.length, 0);
  // The transport pads only the reply's last slice: 1 280 samples become 8 slices, 1 280, not 1 600.
  expect(written).toBe(1_280);
  call.close();
});

it("sends the caller's words from while the session started once it is ready", async () => {
  const room = new FakeRoom();
  const webRTC = new FakeWebRTC();
  const connecting = ElevenLabsCall.connect({
    relay: {} as Relay,
    callId: "01995bc0-0000-7000-8000-000000000001",
    elevenlabs: { agentId: "agent_1", signedUrl: "wss://example" },
    roomClient: room as unknown as CallRoom,
    webRTC: webRTC as unknown as RelayWebRTCFactory,
    WebSocket: FakeSocket,
  });
  await flush();
  webRTC.peer.ontrack?.({ track: { kind: "audio", stop() {} } });
  webRTC.sinks[0]!.ondata?.({ samples: new Int16Array([5, 6]), sampleRate: 16_000, channelCount: 1, bitsPerSample: 16, numberOfFrames: 2 });
  const socket = FakeSocket.last!;
  socket.server(metadata());
  const call = await connecting;
  expect(socket.sent).toContainEqual({ user_audio_chunk: Buffer.from(new Int16Array([5, 6]).buffer).toString("base64") });
  call.close();
});

it("holds mouth shapes until the Rive channel opens, drops unsent ones on interruption, and rests after an unaligned final chunk", async () => {
  const { call, socket, room, webRTC } = await start();
  // Audio and alignment arrive before the channel opens; 1 s of audio so later shapes are not yet due.
  socket.server({
    type: "audio",
    audio_event: {
      audio_base_64: pcm(new Array(16_000).fill(3)),
      event_id: 1,
      alignment: { chars: ["m", "a", "o"], char_start_times_ms: [0, 10, 900], char_durations_ms: [10, 10, 10] },
    },
  });
  await flush();
  room.emit("rive", { type: "rive", id: 4 });
  await flush();
  const channel = webRTC.peer.channels[0]!;
  channel.readyState = "open";
  channel.onopen?.();
  await flush();
  const sent = () => channel.sent.map((text) => JSON.parse(text) as { t?: number; view_model?: Record<string, unknown> });
  // Sent now: what plays within 300 ms of the audio being sent (10 000 ms); the "o" at 10 900 waits.
  expect(sent().map((message) => message.t)).toEqual([10_000, 10_000, 10_010]);
  socket.server({ type: "interruption", interruption_event: { event_id: 2 } });
  // The track moves on past where the dropped "o" would have played.
  webRTC.source.rtpMs = 10_700;
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(sent().at(-1)).toEqual({ view_model: { viseme: 0, speaking: false } });
  expect(sent().some((message) => message.t === 10_900)).toBe(false);

  // A final chunk without alignment still rests the mouth where the reply ends.
  webRTC.source.rtpMs = 20_000;
  webRTC.source.queued = 0;
  socket.server({ type: "audio", audio_event: { audio_base_64: pcm(new Array(160).fill(1)), event_id: 3, alignment: { chars: ["a"], char_start_times_ms: [0], char_durations_ms: [10] } } });
  socket.server({ type: "audio", audio_event: { audio_base_64: pcm(new Array(160).fill(1)), event_id: 3, is_final: true } });
  await flush();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(sent().at(-1)).toEqual({ t: 20_020, view_model: { viseme: 0, speaking: false } });
  call.close();
});

it("fails connect without opening ElevenLabs when the caller hangs up while the signed URL is minted", async () => {
  const room = new FakeRoom();
  let release!: () => void;
  FakeSocket.last = undefined;
  const connecting = ElevenLabsCall.connect({
    relay: {} as Relay,
    callId: "01995bc0-0000-7000-8000-000000000001",
    elevenlabs: { agentId: "agent_1", apiKey: "xi-test" },
    roomClient: room as unknown as CallRoom,
    webRTC: new FakeWebRTC() as unknown as RelayWebRTCFactory,
    WebSocket: FakeSocket,
    fetch: (async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return new Response(JSON.stringify({ signed_url: "wss://api.elevenlabs.io/v1/convai/conversation?token=t" }));
    }) as unknown as typeof fetch,
  });
  await flush();
  room.emit("ended", { type: "ended", reason: "canceled" });
  release();
  await expect(connecting).rejects.toThrow(/ended before the ElevenLabs session started/u);
  expect(FakeSocket.last).toBeUndefined();
});

it("fails connect at once, and cancels the request, when the caller hangs up while a signed URL request hangs", async () => {
  const room = new FakeRoom();
  FakeSocket.last = undefined;
  let aborted = false;
  const connecting = ElevenLabsCall.connect({
    relay: {} as Relay,
    callId: "01995bc0-0000-7000-8000-000000000001",
    elevenlabs: { agentId: "agent_1", apiKey: "xi-test" },
    roomClient: room as unknown as CallRoom,
    webRTC: new FakeWebRTC() as unknown as RelayWebRTCFactory,
    WebSocket: FakeSocket,
    // ElevenLabs never answers this request.
    fetch: ((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => { aborted = true; reject(init.signal!.reason); });
    })) as unknown as typeof fetch,
  });
  await flush();
  room.emit("ended", { type: "ended", reason: "canceled" });
  await expect(connecting).rejects.toThrow(/ended before the ElevenLabs session started/u);
  expect(aborted).toBe(true);
  expect(FakeSocket.last).toBeUndefined();
});

it("plays the agent's last words out before ending the call when ElevenLabs closes the conversation", async () => {
  let drained!: () => void;
  const source = new FakeSource();
  source.waitForDrain = () => new Promise<void>((resolve) => { source.drains += 1; drained = resolve; });
  const { call, socket, room } = await start({ rive: false }, source);
  // The final words, then ElevenLabs hangs up while they are still queued.
  socket.server({ type: "audio", audio_event: { audio_base_64: pcm(new Array(1_600).fill(5)), event_id: 1 } });
  await flush();
  socket.close();
  await flush();
  expect(source.cleared).toBe(0);
  expect(room.sent.some((frame) => frame.type === "end")).toBe(false);
  drained();
  await call.closed;
  expect(source.written.reduce((n, w) => n + w.samples.length, 0)).toBe(1_600);
  expect(room.sent.at(-1)).toEqual({ type: "end" });
});
