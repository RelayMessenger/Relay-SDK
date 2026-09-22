import { beforeEach, expect, it, vi } from "vitest";
import type {
  CallRoom,
  CallRoomEventMap,
  CallRoomServerAnswerFrame,
  CallRoomStateFrame,
  CallRoomSubscriptionOfferFrame,
  Relay,
} from "@relaymessenger/sdk";
import {
  RelayCallTransport,
  RelayCallTransportError,
  type RelayAudioSinkLike,
  type RelayAudioSinkStats,
  type RelayAudioSourceLike,
  type RelayAudioSourceStats,
  type RelayMediaStreamTrackLike,
  type RelayPeerConnectionConfig,
  type RelayPeerConnectionLike,
  type RelayWebRTCFactory,
} from "../src/transport.js";

type RoomEvent = Extract<keyof CallRoomEventMap, string>;

class FakeRoom {
  readonly listeners = new Map<string, Set<(...args: any[]) => void>>();
  readonly sent: unknown[] = [];
  connects = 0;
  reconnects = 0;
  closes = 0;

  async connect(): Promise<void> { this.connects += 1; }
  async reconnect(): Promise<void> { this.reconnects += 1; }
  send(frame: unknown): void { this.sent.push(structuredClone(frame)); }
  connected(): void { this.send({ type: "connected" }); }
  userUpdate(update: { muted: boolean }): void { this.send({ type: "userUpdate", muted: update.muted }); }
  end(): void { this.send({ type: "end" }); }
  close(): void { this.closes += 1; }
  on<K extends RoomEvent>(event: K, listener: (...args: CallRoomEventMap[K]) => void): this {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener as (...args: any[]) => void);
    this.listeners.set(event, listeners);
    return this;
  }
  emit<K extends RoomEvent>(event: K, ...args: CallRoomEventMap[K]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

class FakeTrack implements RelayMediaStreamTrackLike {
  kind = "audio";
  stopped = false;
  stop(): void { this.stopped = true; }
}

class FakeAudioSource implements RelayAudioSourceLike {
  readonly track = new FakeTrack();
  readonly data: Parameters<RelayAudioSourceLike["onData"]>[0][] = [];
  /** Set to make the fake engine report outbound packet counts. */
  sourceStats: RelayAudioSourceStats | undefined;
  createTrack(): RelayMediaStreamTrackLike { return this.track; }
  onData(data: Parameters<RelayAudioSourceLike["onData"]>[0]): void {
    this.data.push({ ...data, samples: data.samples.slice() });
  }
  stats(): RelayAudioSourceStats {
    return this.sourceStats ?? {
      opusPackets: 0, rtpPackets: 0, firstRtpAt: undefined, lastRtpAt: undefined,
      recentRtpPackets: 0, queued: 0, pacerAlive: false,
    };
  }
}

class FakeAudioSink implements RelayAudioSinkLike {
  ondata: RelayAudioSinkLike["ondata"] = null;
  stopped = false;
  sinkStats: RelayAudioSinkStats | undefined;
  stop(): void { this.stopped = true; }
  stats(): RelayAudioSinkStats {
    return this.sinkStats ?? {
      rtpPackets: 0, decodeFailures: 0, firstRtpAt: undefined, lastRtpAt: undefined, recentRtpPackets: 0,
    };
  }
}

class FakePeer implements RelayPeerConnectionLike {
  connectionState = "new";
  iceGatheringState = "complete";
  iceConnectionState = "new";
  signalingState = "stable";
  localDescription: RTCSessionDescription | null = null;
  remoteDescription: RTCSessionDescription | null = null;
  onconnectionstatechange: (() => void) | null = null;
  onicecandidate: ((event: { candidate?: { candidate: string } | null }) => void) | null = null;
  onicegatheringstatechange: ((event?: unknown) => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  ontrack: ((event: { track: RelayMediaStreamTrackLike }) => void) | null = null;
  /** Set to true to simulate a peer whose ICE never completes. */
  neverConnects = false;
  readonly transceiver = { mid: "0" };
  direction: "sendonly" | undefined;
  closed = false;

  addTransceiver(
    _track: RelayMediaStreamTrackLike,
    init: { direction: "sendonly" },
  ): { mid: string } {
    this.direction = init.direction;
    return this.transceiver;
  }
  async createOffer(): Promise<RTCSessionDescriptionInit> { return { type: "offer", sdp: "offer-sdp" }; }
  async createAnswer(): Promise<RTCSessionDescriptionInit> { return { type: "answer", sdp: "answer-sdp" }; }
  async setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = description as RTCSessionDescription;
    if (description.type === "answer") this.signalingState = "stable";
    else this.signalingState = "have-local-offer";
  }
  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = description as RTCSessionDescription;
    if (description.type === "offer") {
      this.signalingState = "have-remote-offer";
    } else {
      this.signalingState = "stable";
      if (this.neverConnects) return;
      this.connectionState = "connected";
      queueMicrotask(() => this.onconnectionstatechange?.());
    }
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void { this.closed = true; this.connectionState = "closed"; }
}

class FakeWebRTC implements RelayWebRTCFactory {
  readonly peer = new FakePeer();
  readonly source = new FakeAudioSource();
  readonly sinks: FakeAudioSink[] = [];
  readonly peerConfigs: RelayPeerConnectionConfig[] = [];
  createPeerConnection(config?: RelayPeerConnectionConfig): RelayPeerConnectionLike {
    if (config) this.peerConfigs.push(structuredClone(config));
    return this.peer;
  }
  createAudioSource(): RelayAudioSourceLike { return this.source; }
  createAudioSink(): RelayAudioSinkLike {
    const sink = new FakeAudioSink();
    this.sinks.push(sink);
    return sink;
  }
}

const flush = async (): Promise<void> => {
  for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
};

const connectTransport = async (
  transport: RelayCallTransport,
  room: FakeRoom,
): Promise<void> => {
  const connecting = transport.connect();
  await flush();
  room.emit("answer", {
    type: "answer",
    session_description: { type: "answer", sdp: "relay-answer" },
  });
  await connecting;
};

const makeTransport = (room: FakeRoom, webRTC: FakeWebRTC): RelayCallTransport =>
  new RelayCallTransport({
    relay: {} as Relay,
    callId: "01995bc0-0000-7000-8000-000000000001",
    roomClient: room as unknown as CallRoom,
    webRTC,
  });

beforeEach(() => vi.useRealTimers());

it("publishes exactly one Relay audio track and handles server renegotiation", async () => {
  const room = new FakeRoom();
  const webRTC = new FakeWebRTC();
  const transport = makeTransport(room, webRTC);
  let connected = false;
  const connecting = transport.connect().then(() => { connected = true; });
  await flush();

  expect(room.connects).toBe(1);
  expect(connected).toBe(false);
  expect(room.sent[0]).toEqual({
    type: "offer",
    session_description: { type: "offer", sdp: "offer-sdp" },
    tracks: [{ mid: "0", name: "audio" }],
  });
  expect(webRTC.peer.direction).toBe("sendonly");

  const answer: CallRoomServerAnswerFrame = {
    type: "answer", session_description: { type: "answer", sdp: "relay-answer" },
  };
  room.emit("answer", answer);
  await connecting;

  expect(webRTC.peer.remoteDescription?.sdp).toBe("relay-answer");
  expect(connected).toBe(true);
  expect(room.sent.at(-1)).toEqual({ type: "connected" });

  const offer: CallRoomSubscriptionOfferFrame = {
    type: "offer", session_description: { type: "offer", sdp: "relay-subscription" }, track: "audio",
  };
  room.emit("offer", offer);
  await flush();
  expect(room.sent.at(-1)).toEqual({
    type: "answer", session_description: { type: "answer", sdp: "answer-sdp" },
  });
  transport.close();
});

it("converts WebRTC sink/source PCM at the provider-neutral boundary", async () => {
  vi.useFakeTimers();
  const room = new FakeRoom();
  const webRTC = new FakeWebRTC();
  const transport = makeTransport(room, webRTC);
  const incoming: Int16Array[] = [];
  transport.on("audio", (frame) => incoming.push(frame.samples));
  await connectTransport(transport, room);

  const remoteTrack = new FakeTrack();
  webRTC.peer.ontrack?.({ track: remoteTrack });
  const nativeSamples = new Int16Array([1, 2, 3, 4]);
  webRTC.sinks[0]?.ondata?.({ samples: nativeSamples, sampleRate: 48_000, bitsPerSample: 16, channelCount: 1 });
  nativeSamples[0] = 99;
  expect([...incoming[0]!]).toEqual([1, 2, 3, 4]);

  const outgoing = transport.writeAudio({
    samples: new Int16Array(960),
    sampleRate: 48_000,
    channelCount: 1,
  });
  await vi.advanceTimersByTimeAsync(20);
  await outgoing;
  expect(webRTC.source.data).toHaveLength(2);
  expect(webRTC.source.data.map((frame) => frame.numberOfFrames)).toEqual([480, 480]);
  expect(webRTC.source.data.every((frame) => frame.bitsPerSample === 16)).toBe(true);
  transport.close();
});

it("reconnects signaling by replaying the same publication and ignores the cached answer", async () => {
  const room = new FakeRoom();
  const webRTC = new FakeWebRTC();
  const transport = makeTransport(room, webRTC);
  await connectTransport(transport, room);
  const firstOffer = structuredClone(room.sent[0]);

  await transport.reconnect();
  expect(room.reconnects).toBe(1);
  expect(room.sent.at(-1)).toEqual(firstOffer);
  room.emit("answer", { type: "answer", session_description: { type: "answer", sdp: "relay-answer" } });
  await flush();
  expect(webRTC.peer.remoteDescription?.sdp).toBe("relay-answer");
  transport.close();
});

it("surfaces room errors and releases media when the Call ends", async () => {
  const room = new FakeRoom();
  const webRTC = new FakeWebRTC();
  const transport = makeTransport(room, webRTC);
  const errors: Error[] = [];
  transport.on("error", (error) => errors.push(error));
  await connectTransport(transport, room);
  webRTC.peer.ontrack?.({ track: new FakeTrack() });

  room.emit("error", { type: "error", code: "media_unavailable", message: "media down" });
  expect(errors[0]).toBeInstanceOf(RelayCallTransportError);
  expect((errors[0] as RelayCallTransportError).code).toBe("media_unavailable");

  room.emit("ended", { type: "ended", reason: "completed" });
  expect(webRTC.peer.closed).toBe(true);
  expect(webRTC.source.track.stopped).toBe(true);
  expect(webRTC.sinks[0]?.stopped).toBe(true);
  transport.close();
});

it("forwards room state and sends call end through the Relay control room", async () => {
  const room = new FakeRoom();
  const webRTC = new FakeWebRTC();
  const transport = makeTransport(room, webRTC);
  await connectTransport(transport, room);
  const statuses: string[] = [];
  transport.on("roomState", (frame) => statuses.push(frame.call.status));

  const state = {
    type: "roomState",
    call: {
      id: "01995bc0-0000-7000-8000-000000000001",
      chat_id: "01995bc0-0000-7000-8000-000000000002",
      from: { id: "user", handle: "alice", kind: "user" },
      to: [{ id: "agent", handle: "relay", kind: "agent" }],
      mode: "audio",
      status: "in-progress",
      revision: 2,
      created_at: "2026-09-22T00:00:00Z",
      ringing_at: "2026-09-22T00:00:00Z",
      answered_at: "2026-09-22T00:00:01Z",
      ended_at: null,
    },
    participants: [
      { contact_id: "user", kind: "user", attached: true, track: "audio", muted: false, connected: true },
      { contact_id: "agent", kind: "agent", attached: true, track: "audio", muted: false, connected: true },
    ],
  } as unknown as CallRoomStateFrame;
  room.emit("roomState", state);
  transport.end();

  expect(statuses).toEqual(["in-progress"]);
  expect(room.sent.at(-1)).toEqual({ type: "end" });
  transport.close();
});

it("reports abnormal signaling closure without destroying the WebRTC peer", async () => {
  const room = new FakeRoom();
  const webRTC = new FakeWebRTC();
  const transport = makeTransport(room, webRTC);
  const closes: number[] = [];
  transport.on("close", (event) => closes.push(event.code));
  await connectTransport(transport, room);
  room.emit("close", { code: 1006, reason: "network", wasClean: false });
  expect(closes).toEqual([1006]);
  expect(webRTC.peer.closed).toBe(false);
  transport.close();
});

it("hands ICE servers and the transport policy to the WebRTC factory", async () => {
  const room = new FakeRoom();
  const webRTC = new FakeWebRTC();
  const defaults = makeTransport(room, webRTC);
  await connectTransport(defaults, room);
  expect(webRTC.peerConfigs).toEqual([{ iceServers: [], iceTransportPolicy: "all" }]);
  defaults.close();

  const turnRoom = new FakeRoom();
  const turnWebRTC = new FakeWebRTC();
  const transport = new RelayCallTransport({
    relay: {} as Relay,
    callId: "01995bc0-0000-7000-8000-000000000001",
    roomClient: turnRoom as unknown as CallRoom,
    webRTC: turnWebRTC,
    iceServers: [
      { urls: "stun:stun.cloudflare.com:3478" },
      {
        urls: ["turn:turn.cloudflare.com:3478?transport=udp", "turns:turn.cloudflare.com:443?transport=tcp"],
        username: "user",
        credential: "secret",
      },
    ],
    iceTransportPolicy: "relay",
  });
  await connectTransport(transport, turnRoom);
  expect(turnWebRTC.peerConfigs).toEqual([{
    iceServers: [
      { urls: "stun:stun.cloudflare.com:3478" },
      {
        urls: ["turn:turn.cloudflare.com:3478?transport=udp", "turns:turn.cloudflare.com:443?transport=tcp"],
        username: "user",
        credential: "secret",
      },
    ],
    iceTransportPolicy: "relay",
  }]);
  transport.close();
});

it("names the gathered candidates and ICE states when media never connects", async () => {
  vi.useFakeTimers();
  const room = new FakeRoom();
  const webRTC = new FakeWebRTC();
  webRTC.peer.neverConnects = true;
  const transport = new RelayCallTransport({
    relay: {} as Relay,
    callId: "01995bc0-0000-7000-8000-000000000001",
    roomClient: room as unknown as CallRoom,
    webRTC,
    mediaConnectTimeoutMs: 2_000,
  });
  const connecting = transport.connect();
  const failed = connecting.then(() => undefined, (error: unknown) => error as Error);
  await flush();

  const peer = webRTC.peer;
  peer.onicecandidate?.({ candidate: { candidate: "candidate:1 1 udp 2130706431 10.0.0.2 51000 typ host" } });
  peer.onicecandidate?.({ candidate: { candidate: "candidate:2 1 udp 2130706431 10.0.0.3 51001 typ host" } });
  peer.onicecandidate?.({ candidate: { candidate: "candidate:3 1 udp 1694498815 203.0.113.9 40000 typ srflx raddr 10.0.0.2 rport 51000" } });
  peer.onicecandidate?.({ candidate: null });
  await vi.advanceTimersByTimeAsync(200);
  peer.iceGatheringState = "complete";
  peer.onicegatheringstatechange?.();
  await vi.advanceTimersByTimeAsync(100);
  room.emit("answer", {
    type: "answer",
    session_description: {
      type: "answer",
      sdp: "v=0\r\na=ice-lite\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=candidate:1 1 udp 2130706431 198.51.100.7 1473 typ host\r\n",
    },
  });
  await flush();
  peer.iceConnectionState = "checking";
  peer.oniceconnectionstatechange?.();
  peer.connectionState = "connecting";
  peer.onconnectionstatechange?.();
  await vi.advanceTimersByTimeAsync(2_000);

  const error = await failed;
  expect(error).toBeInstanceOf(RelayCallTransportError);
  expect(error?.message).toBe(
    "Timed out connecting Relay WebRTC media (local: host 2, srflx 1, relay 0; remote: udp 1473; "
    + "states: new\u2192complete 0.2s, ice checking 0.3s, connecting 0.3s, no connected; "
    + "in: 0 rtp, 0 bad, 0 frames, no packets, 0/5s; "
    + "out: 0 frames, 0 opus, 0 rtp, no packets, 0/5s, queue 0, pacer idle; room: 0 roomState, 0 offer)",
  );
  expect(error?.message).not.toContain("198.51.100");
  const diagnostics = transport.diagnostics();
  expect(diagnostics.local).toEqual({ host: 2, srflx: 1, relay: 0, other: 0 });
  expect(diagnostics.remote).toEqual([{ transport: "udp", port: 1473 }]);
  expect(diagnostics.connected).toBe(false);
  expect(error?.message).toContain(diagnostics.summary);
  expect(webRTC.peer.closed).toBe(true);
});

it("counts packets both ways, room frames, and renders one clause per direction", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  const room = new FakeRoom();
  const webRTC = new FakeWebRTC();
  const transport = makeTransport(room, webRTC);
  const errors: Error[] = [];
  transport.on("error", (error) => errors.push(error));
  await connectTransport(transport, room);
  const connectedAt = Date.now();

  webRTC.peer.ontrack?.({ track: new FakeTrack() });
  const sink = webRTC.sinks[0]!;
  for (let i = 0; i < 3; i += 1) {
    sink.ondata?.({ samples: new Int16Array(960), sampleRate: 48_000, bitsPerSample: 16, channelCount: 2 });
  }
  sink.sinkStats = {
    rtpPackets: 1234, decodeFailures: 2, firstRtpAt: connectedAt + 900, lastRtpAt: connectedAt + 41_200,
    recentRtpPackets: 250,
  };
  webRTC.source.sourceStats = {
    opusPackets: 2050, rtpPackets: 2049, firstRtpAt: connectedAt + 1_100, lastRtpAt: connectedAt + 41_000,
    recentRtpPackets: 249, queued: 1, pacerAlive: true,
  };
  const outgoing = transport.writeAudio({ samples: new Int16Array(1920), sampleRate: 48_000, channelCount: 1 });
  await vi.advanceTimersByTimeAsync(50);
  await outgoing;

  room.emit("roomState", { type: "roomState", call: { status: "in-progress" }, participants: [] } as unknown as CallRoomStateFrame);
  room.emit("roomState", { type: "roomState", call: { status: "in-progress" }, participants: [] } as unknown as CallRoomStateFrame);
  room.emit("offer", { type: "offer", session_description: { type: "offer", sdp: "relay-subscription" }, track: "audio" });
  await flush();
  room.emit("error", { type: "error", code: "media_unavailable", message: "media down" });
  room.emit("ended", { type: "ended", reason: "completed" });

  const diagnostics = transport.diagnostics();
  expect(diagnostics.inbound).toEqual({
    rtpPackets: 1234, decodeFailures: 2, frames: 3, firstPacketAtMs: 900, lastPacketAtMs: 41_200, recentRtpPackets: 250,
  });
  expect(diagnostics.outbound).toEqual({
    frames: 4, opusPackets: 2050, rtpPackets: 2049, firstPacketAtMs: 1_100, lastPacketAtMs: 41_000,
    recentRtpPackets: 249, queued: 1, pacerAlive: true,
  });
  expect(diagnostics.room).toEqual({ roomStates: 2, offers: 1, endedReason: "completed", errors: ["media down"] });
  expect(diagnostics.summary).toContain("in: 1234 rtp, 2 bad, 3 frames, first 0.9s last 41.2s, 250/5s");
  expect(diagnostics.summary).toContain(
    "out: 4 frames, 2050 opus, 2049 rtp, first 1.1s last 41.0s, 249/5s, queue 1, pacer alive",
  );
  expect(diagnostics.summary).toContain('room: 2 roomState, 1 offer, ended completed, error "media down"');
  expect(errors).toHaveLength(1);
  transport.close();
});

it("warns once when outbound audio is queued but no RTP leaves for 2 s", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(200_000);
  const room = new FakeRoom();
  const webRTC = new FakeWebRTC();
  const warnings: string[] = [];
  const transport = new RelayCallTransport({
    relay: {} as Relay,
    callId: "01995bc0-0000-7000-8000-000000000001",
    roomClient: room as unknown as CallRoom,
    webRTC,
    onWarning: (message) => warnings.push(message),
  });
  await connectTransport(transport, room);
  const lastRtpAt = Date.now();
  webRTC.source.sourceStats = {
    opusPackets: 10, rtpPackets: 5, firstRtpAt: lastRtpAt - 100, lastRtpAt, recentRtpPackets: 5,
    queued: 5, pacerAlive: false,
  };
  await vi.advanceTimersByTimeAsync(1_500);
  expect(warnings).toEqual([]);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toMatch(/^Relay outbound audio stalled \(local: /);
  expect(warnings[0]).toContain("out: 0 frames, 10 opus, 5 rtp, first -0.1s last 0.0s, 5/5s, queue 5, pacer idle");
  await vi.advanceTimersByTimeAsync(10_000);
  expect(warnings).toHaveLength(1);
  expect(webRTC.peer.closed).toBe(false);
  transport.close();
});

it("does not warn while the pacer keeps draining the queue", async () => {
  vi.useFakeTimers();
  const room = new FakeRoom();
  const webRTC = new FakeWebRTC();
  const warnings: string[] = [];
  const transport = new RelayCallTransport({
    relay: {} as Relay,
    callId: "01995bc0-0000-7000-8000-000000000001",
    roomClient: room as unknown as CallRoom,
    webRTC,
    onWarning: (message) => warnings.push(message),
  });
  await connectTransport(transport, room);
  for (let tick = 0; tick < 10; tick += 1) {
    const now = Date.now();
    webRTC.source.sourceStats = {
      opusPackets: tick, rtpPackets: tick, firstRtpAt: now, lastRtpAt: now, recentRtpPackets: 1,
      queued: 3, pacerAlive: true,
    };
    await vi.advanceTimersByTimeAsync(500);
  }
  expect(warnings).toEqual([]);
  transport.close();
});
