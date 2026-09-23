import { beforeEach, expect, it, vi } from "vitest";
import type {
  CallRoom,
  CallRoomEventMap,
  CallRoomIceServer,
  CallRoomServerAnswerFrame,
  CallRoomStateFrame,
  CallRoomSubscriptionOfferFrame,
  Relay,
} from "@relaymessenger/sdk";
import {
  RESTART_MAX_DELAY_MS,
  RelayCallTransport,
  RelayCallTransportError,
  restartDelayMs,
  type RelayCallRestartEvent,
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
  /** What Relay's room sends after `join` when it cannot mint TURN (PROTOCOL.md section 6). */
  iceServers: CallRoomIceServer[] | null = [{ urls: ["stun:stun.cloudflare.com:3478"] }];
  state: CallRoomStateFrame | null = null;
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
  off<K extends RoomEvent>(event: K, listener: (...args: CallRoomEventMap[K]) => void): this {
    this.listeners.get(event)?.delete(listener as (...args: any[]) => void);
    return this;
  }
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
  starts = 0;
  createTrack(): RelayMediaStreamTrackLike { return this.track; }
  start(): void { this.starts += 1; }
  onData(data: Parameters<RelayAudioSourceLike["onData"]>[0]): void {
    this.data.push({ ...data, samples: data.samples.slice() });
  }
  stats(): RelayAudioSourceStats {
    return this.sourceStats ?? {
      opusPackets: 0, rtpPackets: 0, silencePackets: 0, firstRtpAt: undefined, lastRtpAt: undefined,
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
  track: RelayMediaStreamTrackLike | undefined;
  closed = false;

  addTransceiver(
    track: RelayMediaStreamTrackLike,
    init: { direction: "sendonly" },
  ): { mid: string } {
    this.track = track;
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

/**
 * werift's shape: `setLocalDescription` applies the description at once but
 * resolves only when gathering completes (peerConnection.js `await
 * this.gatherCandidates()`), and a later description on the same transport
 * resolves at once. `finishGathering()` completes the first.
 */
class SlowGatherPeer extends FakePeer {
  override iceGatheringState = "new";
  #finish: (() => void) | undefined;
  override async setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    await super.setLocalDescription(description);
    // RTCIceTransport.gather() runs once, from "new" (transport/ice.js).
    if (this.iceGatheringState !== "new") return;
    this.iceGatheringState = "gathering";
    await new Promise<void>((resolve) => { this.#finish = resolve; });
  }
  finishGathering(): void {
    this.iceGatheringState = "complete";
    this.#finish?.();
  }
}

class FakeWebRTC implements RelayWebRTCFactory {
  /** Every peer connection built, in order; a restart builds a new one. */
  readonly peers: FakePeer[] = [];
  /** The peer the next `createPeerConnection` returns; configure it before it is built. */
  nextPeer = new FakePeer();
  readonly source = new FakeAudioSource();
  sourcesCreated = 0;
  readonly sinks: FakeAudioSink[] = [];
  readonly peerConfigs: RelayPeerConnectionConfig[] = [];
  /** The latest peer built, or the one about to be. */
  get peer(): FakePeer { return this.peers.at(-1) ?? this.nextPeer; }
  createPeerConnection(config?: RelayPeerConnectionConfig): RelayPeerConnectionLike {
    if (config) this.peerConfigs.push(structuredClone(config));
    const peer = this.nextPeer;
    this.peers.push(peer);
    this.nextPeer = new FakePeer();
    return peer;
  }
  createAudioSource(): RelayAudioSourceLike { this.sourcesCreated += 1; return this.source; }
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

/** Cloudflare's `generate-ice-servers` response shape (realtime/turn/generate-credentials.mdx). */
const ROOM_TURN = (username: string): CallRoomIceServer[] => [
  { urls: ["stun:stun.cloudflare.com:3478", "stun:stun.cloudflare.com:53"] },
  {
    urls: [
      "turn:turn.cloudflare.com:3478?transport=udp",
      "turn:turn.cloudflare.com:53?transport=udp",
      "turn:turn.cloudflare.com:3478?transport=tcp",
      "turn:turn.cloudflare.com:80?transport=tcp",
      "turns:turn.cloudflare.com:5349?transport=tcp",
      "turns:turn.cloudflare.com:443?transport=tcp",
    ],
    username,
    credential: `${username}-credential`,
  },
];

/** What the SDK's CallRoom does with an `iceServers` frame: store it, then emit. */
const sendRoomIceServers = (room: FakeRoom, iceServers: CallRoomIceServer[]): void => {
  room.iceServers = iceServers;
  room.emit("iceServers", { type: "iceServers", ice_servers: iceServers });
};

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
  // No application servers: the room's `iceServers` frame.
  expect(webRTC.peerConfigs).toEqual([{
    iceServers: [{ urls: ["stun:stun.cloudflare.com:3478"] }],
    iceTransportPolicy: "all",
  }]);
  defaults.close();

  // An application value wins over the room's servers.
  const turnRoom = new FakeRoom();
  turnRoom.iceServers = [ROOM_TURN("room-user")[1]!];
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

it("names the gathered candidates and ICE states of a session it gives up on", async () => {
  vi.useFakeTimers();
  const room = new FakeRoom();
  const webRTC = new FakeWebRTC();
  webRTC.peer.neverConnects = true;
  const transport = new RelayCallTransport({
    relay: {} as Relay,
    callId: "01995bc0-0000-7000-8000-000000000001",
    roomClient: room as unknown as CallRoom,
    webRTC,
    sessionConnectTimeoutMs: 2_000,
  });
  const restarted: RelayCallRestartEvent[] = [];
  transport.on("restarted", (event) => restarted.push(event));
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
  const diagnostics = transport.diagnostics();
  await vi.advanceTimersByTimeAsync(1_999);
  expect(peer.closed).toBe(false);
  await vi.advanceTimersByTimeAsync(1 + 250);
  await flush();

  expect(peer.closed).toBe(true);
  expect(restarted).toHaveLength(1);
  expect(restarted[0]!.summary).toBe(
    "local: host 2, srflx 1, relay 0; remote: udp 1473; "
    + "states: new\u2192complete 0.2s, ice checking 0.3s, connecting 0.3s, no connected; "
    + "in: 0 rtp, 0 bad, 0 frames, no packets, 0/5s; "
    + "out: 0 frames, 0 opus, 0 rtp, silence 0, no packets, 0/5s, queue 0, pacer idle; room: 0 roomState, 0 offer",
  );
  expect(restarted[0]!.summary).toBe(diagnostics.summary);
  expect(restarted[0]!.summary).not.toContain("198.51.100");
  expect(diagnostics.local).toEqual({ host: 2, srflx: 1, relay: 0, other: 0 });
  expect(diagnostics.remote).toEqual([{ transport: "udp", port: 1473 }]);
  expect(diagnostics.connected).toBe(false);
  transport.close();
  const error = await failed;
  expect(error).toBeInstanceOf(RelayCallTransportError);
  expect(error?.message).toBe("Relay Call transport closed before media connected.");
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
    opusPackets: 2050, rtpPackets: 2049, silencePackets: 300, firstRtpAt: connectedAt + 1_100,
    lastRtpAt: connectedAt + 41_000, recentRtpPackets: 249, queued: 1, pacerAlive: true,
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
    frames: 4, opusPackets: 2050, rtpPackets: 2049, silencePackets: 300, firstPacketAtMs: 1_100,
    lastPacketAtMs: 41_000, recentRtpPackets: 249, queued: 1, pacerAlive: true,
  });
  expect(diagnostics.room).toEqual({ roomStates: 2, offers: 1, endedReason: "completed", errors: ["media down"] });
  expect(diagnostics.summary).toContain("in: 1234 rtp, 2 bad, 3 frames, first 0.9s last 41.2s, 250/5s");
  expect(diagnostics.summary).toContain(
    "out: 4 frames, 2050 opus, 2049 rtp, silence 300, first 1.1s last 41.0s, 249/5s, queue 1, pacer alive",
  );
  expect(diagnostics.summary).toContain('room: 2 roomState, 1 offer, ended completed, error "media down"');
  expect(errors).toHaveLength(1);
  transport.close();
});

it("starts the audio source's silence when the peer connects, not before", async () => {
  const room = new FakeRoom();
  const webRTC = new FakeWebRTC();
  const transport = makeTransport(room, webRTC);
  const connecting = transport.connect();
  await flush();
  expect(webRTC.source.starts).toBe(0);
  room.emit("answer", { type: "answer", session_description: { type: "answer", sdp: "relay-answer" } });
  await connecting;
  expect(webRTC.source.starts).toBe(1);
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
    opusPackets: 10, rtpPackets: 5, silencePackets: 0, firstRtpAt: lastRtpAt - 100, lastRtpAt,
    recentRtpPackets: 5, queued: 5, pacerAlive: false,
  };
  await vi.advanceTimersByTimeAsync(1_500);
  expect(warnings).toEqual([]);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toMatch(/^Relay outbound audio stalled \(local: /);
  expect(warnings[0]).toContain("out: 0 frames, 10 opus, 5 rtp, silence 0, first -0.1s last 0.0s, 5/5s, queue 5, pacer idle");
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
      opusPackets: tick, rtpPackets: tick, silencePackets: 0, firstRtpAt: now, lastRtpAt: now,
      recentRtpPackets: 1, queued: 3, pacerAlive: true,
    };
    await vi.advanceTimersByTimeAsync(500);
  }
  expect(warnings).toEqual([]);
  transport.close();
});

it("refuses an inbound format the wrtc engine cannot decode to, and bad formats on any engine", () => {
  const base = {
    relay: {} as Relay,
    callId: "01995bc0-0000-7000-8000-000000000001",
    roomClient: new FakeRoom() as unknown as CallRoom,
  };
  expect(() => new RelayCallTransport({
    ...base,
    engine: "wrtc",
    inboundAudio: { sampleRate: 24_000, channelCount: 1 },
  })).toThrow('The "wrtc" engine cannot decode to inboundAudio; use the "werift" engine.');
  expect(() => new RelayCallTransport({
    ...base,
    engine: "wrtc",
    inboundAudio: { sampleRate: 48_000, channelCount: 2 },
  })).not.toThrow();
  expect(() => new RelayCallTransport({
    ...base,
    inboundAudio: { sampleRate: 44_100 as 48_000, channelCount: 1 },
  })).toThrow("inboundAudio.sampleRate must be 8000, 12000, 16000, 24000 or 48000.");
  expect(() => new RelayCallTransport({
    ...base,
    inboundAudio: { sampleRate: 24_000, channelCount: 3 as 1 },
  })).toThrow("inboundAudio.channelCount must be 1 or 2.");
});

const answerLatest = (room: FakeRoom, sdp = "relay-answer"): void => {
  room.emit("answer", { type: "answer", session_description: { type: "answer", sdp } });
};

const offersSent = (room: FakeRoom): Array<Record<string, unknown>> =>
  room.sent.filter((frame) => (frame as { type: string }).type === "offer") as Array<Record<string, unknown>>;

const roomStateFrame = (
  status: string,
  person: Record<string, unknown> = {},
): CallRoomStateFrame => ({
  type: "roomState",
  call: { id: "call", chat_id: "chat", status },
  participants: [
    { contact_id: "user", kind: "user", attached: true, track: "audio", muted: false, connected: true, ...person },
    { contact_id: "agent", kind: "agent", attached: true, track: "audio", muted: false, connected: true },
  ],
} as unknown as CallRoomStateFrame);

it("restarts onto a new session when the first never connects, and the same source feeds the new peer", async () => {
  vi.useFakeTimers();
  const room = new FakeRoom();
  const webRTC = new FakeWebRTC();
  webRTC.nextPeer.neverConnects = true;
  const iceCalls: number[] = [];
  const transport = new RelayCallTransport({
    relay: {} as Relay,
    callId: "01995bc0-0000-7000-8000-000000000001",
    roomClient: room as unknown as CallRoom,
    webRTC,
    iceServers: async ({ restarts }) => {
      iceCalls.push(restarts);
      return [{ urls: "turn:turn.cloudflare.com:3478", username: `u${restarts}`, credential: "c" }];
    },
  });
  const restarted: RelayCallRestartEvent[] = [];
  transport.on("restarted", (event) => restarted.push(event));
  const inbound: number[] = [];
  transport.on("audio", (frame) => inbound.push(frame.samples[0]!));
  let connected = false;
  const connecting = transport.connect().then(() => { connected = true; });
  await flush();
  answerLatest(room);
  await flush();
  const first = webRTC.peers[0]!;
  expect(offersSent(room)).toEqual([{
    type: "offer",
    session_description: { type: "offer", sdp: "offer-sdp" },
    tracks: [{ mid: "0", name: "audio" }],
  }]);

  // Audio written while the first session is dead goes into the one source.
  await transport.writeAudio({ samples: new Int16Array(480).fill(1), sampleRate: 48_000, channelCount: 1 });
  await vi.advanceTimersByTimeAsync(4_999);
  expect(webRTC.peers).toHaveLength(1);
  expect(first.closed).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(first.closed).toBe(true);
  expect(webRTC.peers).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(250);
  await flush();

  const second = webRTC.peers[1]!;
  expect(webRTC.peers).toHaveLength(2);
  expect(offersSent(room).at(-1)).toEqual({
    type: "offer",
    session_description: { type: "offer", sdp: "offer-sdp" },
    tracks: [{ mid: "0", name: "audio" }],
    restart: true,
  });
  expect(iceCalls).toEqual([0, 1]);
  expect(webRTC.peerConfigs.map((config) => config.iceServers[0]?.username)).toEqual(["u0", "u1"]);
  expect(restarted).toMatchObject([{ reason: "timeout", restarts: 1, delayMs: 250 }]);
  expect(connected).toBe(false);

  answerLatest(room, "relay-answer-2");
  await connecting;
  expect(connected).toBe(true);
  expect(second.remoteDescription?.sdp).toBe("relay-answer-2");
  expect(room.sent.filter((frame) => (frame as { type: string }).type === "connected")).toHaveLength(1);

  // One source and one local track for the whole call, handed to each new peer.
  expect(webRTC.sourcesCreated).toBe(1);
  expect(first.track).toBe(webRTC.source.track);
  expect(second.track).toBe(webRTC.source.track);
  expect(webRTC.source.track.stopped).toBe(false);
  await transport.writeAudio({ samples: new Int16Array(480).fill(2), sampleRate: 48_000, channelCount: 1 });
  expect(webRTC.source.data.map((frame) => frame.samples[0])).toEqual([1, 2]);

  // The new peer's remote track feeds the same `audio` event.
  second.ontrack?.({ track: new FakeTrack() });
  webRTC.sinks.at(-1)?.ondata?.({ samples: new Int16Array([7, 7]), sampleRate: 48_000, bitsPerSample: 16, channelCount: 1 });
  expect(inbound).toEqual([7]);
  expect(transport.diagnostics().restarts).toBe(1);
  expect(transport.diagnostics().summary).toMatch(/; restarts 1$/);
  transport.close();
});

it("restarts at once when the connection state becomes failed, and ignores the retired peer", async () => {
  vi.useFakeTimers();
  const room = new FakeRoom();
  const webRTC = new FakeWebRTC();
  const transport = makeTransport(room, webRTC);
  const restarted: RelayCallRestartEvent[] = [];
  transport.on("restarted", (event) => restarted.push(event));
  const errors: Error[] = [];
  transport.on("error", (error) => errors.push(error));
  await connectTransport(transport, room);
  const first = webRTC.peers[0]!;
  const firstSink = (first.ontrack?.({ track: new FakeTrack() }), webRTC.sinks[0]!);

  first.connectionState = "failed";
  first.onconnectionstatechange?.();
  expect(first.closed).toBe(true);
  expect(firstSink.stopped).toBe(true);
  expect(first.onconnectionstatechange).toBeNull();
  await vi.advanceTimersByTimeAsync(250);
  await flush();
  expect(webRTC.peers).toHaveLength(2);
  expect(offersSent(room).at(-1)?.restart).toBe(true);
  expect(restarted).toMatchObject([{ reason: "failed", restarts: 1, delayMs: 250 }]);
  expect(errors).toEqual([]);
  transport.close();
});

it("restarts after the connection stays disconnected for 7 s, not when it recovers", async () => {
  vi.useFakeTimers();
  const room = new FakeRoom();
  const webRTC = new FakeWebRTC();
  const transport = makeTransport(room, webRTC);
  const restarted: RelayCallRestartEvent[] = [];
  transport.on("restarted", (event) => restarted.push(event));
  await connectTransport(transport, room);
  const first = webRTC.peers[0]!;

  first.connectionState = "disconnected";
  first.onconnectionstatechange?.();
  await vi.advanceTimersByTimeAsync(3_000);
  first.connectionState = "connected";
  first.onconnectionstatechange?.();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(webRTC.peers).toHaveLength(1);
  expect(room.sent.filter((frame) => (frame as { type: string }).type === "connected")).toHaveLength(1);

  first.connectionState = "disconnected";
  first.onconnectionstatechange?.();
  await vi.advanceTimersByTimeAsync(6_999);
  expect(first.closed).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(first.closed).toBe(true);
  await vi.advanceTimersByTimeAsync(250);
  await flush();
  expect(webRTC.peers).toHaveLength(2);
  expect(restarted).toMatchObject([{ reason: "disconnected", restarts: 1, delayMs: 250 }]);
  transport.close();
});

it("backs off 250 ms x1.1 per dead session, capped at 10 s, resets on connect, and stops when the Call ends", async () => {
  expect(restartDelayMs(1)).toBe(250);
  expect(restartDelayMs(2)).toBeCloseTo(275, 9);
  expect(restartDelayMs(3)).toBeCloseTo(302.5, 9);
  expect(restartDelayMs(40)).toBe(RESTART_MAX_DELAY_MS);
  expect(RESTART_MAX_DELAY_MS).toBe(10_000);

  vi.useFakeTimers();
  const room = new FakeRoom();
  const webRTC = new FakeWebRTC();
  webRTC.nextPeer.neverConnects = true;
  const transport = new RelayCallTransport({
    relay: {} as Relay,
    callId: "01995bc0-0000-7000-8000-000000000001",
    roomClient: room as unknown as CallRoom,
    webRTC,
  });
  const delays: number[] = [];
  transport.on("restarted", (event) => delays.push(event.delayMs));
  const connecting = transport.connect();
  await flush();
  room.emit("roomState", roomStateFrame("ringing"));
  const offerTimes: number[] = [];
  const started = Date.now();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    webRTC.nextPeer.neverConnects = true;
    offerTimes.push(Date.now() - started);
    answerLatest(room);
    await flush();
    const before = webRTC.peers.length;
    while (webRTC.peers.length === before) await vi.advanceTimersByTimeAsync(1);
    await flush();
  }
  expect(delays.map((ms) => Math.round(ms * 100) / 100)).toEqual([250, 275, 302.5, 332.75]);
  // Answer applied at once, so each gap is the 5 s connect wait plus that backoff.
  const gaps = offerTimes.slice(1).map((ms, index) => ms - offerTimes[index]!);
  [5_250, 5_275, 5_302.5].forEach((expected, index) => expect(Math.abs(gaps[index]! - expected)).toBeLessThanOrEqual(1));

  // A session that connects resets the backoff to 250 ms.
  webRTC.peer.neverConnects = false;
  answerLatest(room);
  await connecting;
  const live = webRTC.peers.at(-1)!;
  live.connectionState = "failed";
  live.onconnectionstatechange?.();
  await vi.advanceTimersByTimeAsync(250);
  await flush();
  expect(delays.at(-1)).toBe(250);

  // Terminal status: the dead session is not replaced.
  room.emit("roomState", roomStateFrame("completed"));
  const peersBefore = webRTC.peers.length;
  const last = webRTC.peers.at(-1)!;
  last.connectionState = "failed";
  last.onconnectionstatechange?.();
  await vi.advanceTimersByTimeAsync(20_000);
  expect(webRTC.peers).toHaveLength(peersBefore);
  expect(last.closed).toBe(false);
  transport.close();
});

it("stops a pending restart when the Call ends during the backoff", async () => {
  vi.useFakeTimers();
  const room = new FakeRoom();
  const webRTC = new FakeWebRTC();
  const transport = makeTransport(room, webRTC);
  const errors: Error[] = [];
  transport.on("error", (error) => errors.push(error));
  await connectTransport(transport, room);
  const first = webRTC.peers[0]!;
  first.connectionState = "failed";
  first.onconnectionstatechange?.();
  room.emit("ended", { type: "ended", reason: "completed" });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(webRTC.peers).toHaveLength(1);
  expect(offersSent(room)).toHaveLength(1);
  expect(transport.diagnostics().restarts).toBe(1);
  expect(errors).toEqual([]);
  transport.close();
});

it("drops a pull offer for the replaced session while the restart offer is unanswered", async () => {
  vi.useFakeTimers();
  const room = new FakeRoom();
  const webRTC = new FakeWebRTC();
  const transport = makeTransport(room, webRTC);
  const errors: Error[] = [];
  transport.on("error", (error) => errors.push(error));
  await connectTransport(transport, room);
  const first = webRTC.peers[0]!;
  first.connectionState = "failed";
  first.onconnectionstatechange?.();
  room.emit("offer", { type: "offer", session_description: { type: "offer", sdp: "old-pull" }, track: "audio" });
  await vi.advanceTimersByTimeAsync(250);
  await flush();
  const second = webRTC.peers[1]!;
  expect(second.signalingState).toBe("have-local-offer");
  expect(second.remoteDescription).toBeNull();
  expect(room.sent.filter((frame) => (frame as { type: string }).type === "answer")).toEqual([]);
  expect(errors).toEqual([]);
  transport.close();
});

it("answers a pull offer that adds the person's video, never decodes it, and reports the camera from roomState", async () => {
  const room = new FakeRoom();
  const webRTC = new FakeWebRTC();
  const transport = makeTransport(room, webRTC);
  const errors: Error[] = [];
  transport.on("error", (error) => errors.push(error));
  const video: boolean[] = [];
  transport.on("remoteVideo", (on) => video.push(on));
  await connectTransport(transport, room);

  room.emit("roomState", roomStateFrame("in-progress", { video: false, tracks: ["audio"] }));
  room.emit("offer", {
    type: "offer",
    session_description: { type: "offer", sdp: "relay-subscription-with-video" },
    track: "video",
  });
  await flush();
  expect(webRTC.peer.remoteDescription?.sdp).toBe("relay-subscription-with-video");
  expect(room.sent.at(-1)).toEqual({ type: "answer", session_description: { type: "answer", sdp: "answer-sdp" } });

  const videoTrack = new FakeTrack();
  videoTrack.kind = "video";
  webRTC.peer.ontrack?.({ track: videoTrack });
  expect(webRTC.sinks).toHaveLength(0);
  webRTC.peer.ontrack?.({ track: new FakeTrack() });
  expect(webRTC.sinks).toHaveLength(1);

  room.emit("roomState", roomStateFrame("in-progress", { video: true, tracks: ["audio", "video"] }));
  room.emit("roomState", roomStateFrame("in-progress", { video: true, tracks: ["audio", "video"] }));
  room.emit("roomState", roomStateFrame("in-progress", { video: false, tracks: ["audio", "video"] }));
  expect(video).toEqual([true, false]);
  expect(errors).toEqual([]);
  transport.close();
});

it("fires peerAudio once, only when the person's audio has arrived and roomState shows them connected", async () => {
  vi.useFakeTimers();
  const room = new FakeRoom();
  const webRTC = new FakeWebRTC();
  const transport = makeTransport(room, webRTC);
  let fired = 0;
  transport.on("peerAudio", () => { fired += 1; });
  await connectTransport(transport, room);
  let resolved = false;
  const waiting = transport.waitForPeerAudio(10_000).then(() => { resolved = true; });

  // Our own media is connected, the person is not, and no audio of theirs has arrived.
  room.emit("roomState", roomStateFrame("in-progress", { connected: false }));
  webRTC.peer.ontrack?.({ track: new FakeTrack() });
  await flush();
  expect(fired).toBe(0);

  // Their audio arrives, but the room still shows them not connected.
  const frame = { samples: new Int16Array([5, 5]), sampleRate: 48_000, bitsPerSample: 16, channelCount: 1 };
  webRTC.sinks[0]!.ondata?.(frame);
  await flush();
  expect(fired).toBe(0);
  expect(resolved).toBe(false);

  room.emit("roomState", roomStateFrame("in-progress", { connected: true }));
  await waiting;
  expect(fired).toBe(1);
  webRTC.sinks[0]!.ondata?.(frame);
  room.emit("roomState", roomStateFrame("in-progress", { connected: true }));
  expect(fired).toBe(1);
  await expect(transport.waitForPeerAudio(1)).resolves.toBeUndefined();
  transport.close();
});

it("fires peerAudio when the person is connected first and their audio arrives second", async () => {
  const room = new FakeRoom();
  const webRTC = new FakeWebRTC();
  const transport = makeTransport(room, webRTC);
  await connectTransport(transport, room);
  const waiting = transport.waitForPeerAudio(10_000);
  room.emit("roomState", roomStateFrame("in-progress", { connected: true }));
  webRTC.peer.ontrack?.({ track: new FakeTrack() });
  webRTC.sinks[0]!.ondata?.({ samples: new Int16Array([1]), sampleRate: 48_000, bitsPerSample: 16, channelCount: 1 });
  await expect(waiting).resolves.toBeUndefined();
  transport.close();
});

it("rejects waitForPeerAudio on timeout, on the Call ending, and on close", async () => {
  vi.useFakeTimers();
  const room = new FakeRoom();
  const webRTC = new FakeWebRTC();
  const transport = makeTransport(room, webRTC);
  await connectTransport(transport, room);
  room.emit("roomState", roomStateFrame("in-progress", { connected: true }));

  const timedOut = transport.waitForPeerAudio(3_000).then(() => undefined, (error: Error) => error);
  await vi.advanceTimersByTimeAsync(2_999);
  const ending = transport.waitForPeerAudio(60_000).then(() => undefined, (error: Error) => error);
  await vi.advanceTimersByTimeAsync(1);
  expect((await timedOut)?.message).toMatch(/^Timed out waiting for the person's audio \(local: /);
  room.emit("ended", { type: "ended", reason: "canceled" });
  expect((await ending)?.message).toBe("Relay Call ended before the person's audio arrived (canceled).");
  await expect(transport.waitForPeerAudio(1_000)).rejects.toThrow(/ended before the person's audio/);
  transport.close();

  const closing = new FakeRoom();
  const other = makeTransport(closing, new FakeWebRTC());
  await connectTransport(other, closing);
  const pending = other.waitForPeerAudio(60_000);
  other.close();
  await expect(pending).rejects.toThrow("Relay Call transport closed before the person's audio arrived.");
  await expect(other.waitForPeerAudio(0)).rejects.toThrow("waitForPeerAudio timeoutMs must be greater than zero.");
});

it("connect() has no deadline: three dead sessions then a live one resolves it", async () => {
  vi.useFakeTimers();
  const room = new FakeRoom();
  const webRTC = new FakeWebRTC();
  const transport = makeTransport(room, webRTC);
  const restarted: RelayCallRestartEvent[] = [];
  transport.on("restarted", (event) => restarted.push(event));
  let settled: string | undefined;
  const connecting = transport.connect().then(() => { settled = "resolved"; }, (error: Error) => { settled = error.message; });
  await flush();
  room.emit("roomState", roomStateFrame("ringing"));
  for (let dead = 0; dead < 3; dead += 1) {
    webRTC.peer.neverConnects = true;
    answerLatest(room);
    await flush();
    const before = webRTC.peers.length;
    while (webRTC.peers.length === before) await vi.advanceTimersByTimeAsync(10);
    await flush();
  }
  // Three dead sessions: well past the old 15 s connect() deadline.
  expect(Date.now()).toBeGreaterThan(15_000);
  expect(settled).toBeUndefined();
  expect(restarted.map((event) => event.reason)).toEqual(["timeout", "timeout", "timeout"]);
  answerLatest(room);
  await connecting;
  expect(settled).toBe("resolved");
  expect(webRTC.peers).toHaveLength(4);
  expect(offersSent(room).map((offer) => offer.restart ?? false)).toEqual([false, true, true, true]);
  transport.close();
});

it("connect() rejects when the Call ends in the middle of a restart", async () => {
  vi.useFakeTimers();
  const room = new FakeRoom();
  const webRTC = new FakeWebRTC();
  webRTC.nextPeer.neverConnects = true;
  const transport = makeTransport(room, webRTC);
  const connecting = transport.connect().then(() => undefined, (error: Error) => error);
  await flush();
  answerLatest(room);
  await vi.advanceTimersByTimeAsync(5_100);
  expect(webRTC.peers[0]!.closed).toBe(true);
  room.emit("ended", { type: "ended", reason: "canceled" });
  const error = await connecting;
  expect(error?.message).toBe("Relay Call ended before media connected (canceled).");
  await vi.advanceTimersByTimeAsync(30_000);
  expect(webRTC.peers).toHaveLength(1);
});

it("connect() rejects and closes the transport when its signal aborts", async () => {
  vi.useFakeTimers();
  const room = new FakeRoom();
  const webRTC = new FakeWebRTC();
  webRTC.nextPeer.neverConnects = true;
  const transport = makeTransport(room, webRTC);
  const controller = new AbortController();
  const connecting = transport.connect({ signal: controller.signal }).then(() => undefined, (error: Error) => error);
  await flush();
  answerLatest(room);
  await vi.advanceTimersByTimeAsync(60_000);
  controller.abort();
  const error = await connecting;
  expect(error).toBeInstanceOf(RelayCallTransportError);
  expect((error as RelayCallTransportError).code).toBe("aborted");
  expect(room.closes).toBe(1);
  await expect(transport.connect({ signal: AbortSignal.abort() })).rejects.toThrow("Relay Call transport is closed.");
});

it("sends the offer at the first local candidate, before ICE gathering completes", async () => {
  const room = new FakeRoom();
  const webRTC = new FakeWebRTC();
  const peer = new SlowGatherPeer();
  webRTC.nextPeer = peer;
  const transport = makeTransport(room, webRTC);
  const connecting = transport.connect();
  await flush();
  expect(peer.signalingState).toBe("have-local-offer");
  expect(room.sent).toEqual([]);

  peer.onicecandidate?.({ candidate: { candidate: "candidate:1 1 udp 2130706431 10.0.0.2 51000 typ host" } });
  await flush();
  expect(peer.iceGatheringState).toBe("gathering");
  expect(room.sent).toEqual([{
    type: "offer",
    session_description: { type: "offer", sdp: "offer-sdp" },
    tracks: [{ mid: "0", name: "audio" }],
  }]);

  room.emit("answer", { type: "answer", session_description: { type: "answer", sdp: "relay-answer" } });
  await connecting;
  // A pull offer while gathering is still running is answered at once too.
  room.emit("offer", {
    type: "offer", session_description: { type: "offer", sdp: "relay-subscription" }, track: "audio",
  });
  await flush();
  expect(room.sent.at(-1)).toEqual({ type: "answer", session_description: { type: "answer", sdp: "answer-sdp" } });
  expect(peer.iceGatheringState).toBe("gathering");
  peer.finishGathering();
  transport.close();
});

it("keeps the person's audio sink and its packet count when ontrack fires again for the same track", async () => {
  const room = new FakeRoom();
  const webRTC = new FakeWebRTC();
  const transport = makeTransport(room, webRTC);
  await connectTransport(transport, room);
  const audio = new FakeTrack();
  webRTC.peer.ontrack?.({ track: audio });
  const sink = webRTC.sinks[0]!;
  sink.sinkStats = {
    rtpPackets: 300, decodeFailures: 0, firstRtpAt: Date.now(), lastRtpAt: Date.now(), recentRtpPackets: 250,
  };

  // werift re-announces every sending m-line when a pull offer adds video.
  const video = Object.assign(new FakeTrack(), { kind: "video" });
  webRTC.peer.ontrack?.({ track: audio });
  webRTC.peer.ontrack?.({ track: video });
  expect(webRTC.sinks).toHaveLength(1);
  expect(sink.stopped).toBe(false);
  expect(transport.diagnostics().inbound.rtpPackets).toBe(300);

  // A different audio track replaces the sink; the call total keeps the old count.
  webRTC.peer.ontrack?.({ track: new FakeTrack() });
  expect(webRTC.sinks).toHaveLength(2);
  expect(sink.stopped).toBe(true);
  webRTC.sinks[1]!.sinkStats = {
    rtpPackets: 50, decodeFailures: 0, firstRtpAt: Date.now(), lastRtpAt: Date.now(), recentRtpPackets: 50,
  };
  expect(transport.diagnostics().inbound.rtpPackets).toBe(350);
  transport.close();
});

it("names the local candidate type of the pair media flows on, from the W3C stats", async () => {
  const room = new FakeRoom();
  const webRTC = new FakeWebRTC();
  const stats = [
    { id: "T01", type: "transport", selectedCandidatePairId: "CP2" },
    { id: "CP1", type: "candidate-pair", localCandidateId: "L1", nominated: false, state: "failed" },
    { id: "CP2", type: "candidate-pair", localCandidateId: "L2", nominated: true, state: "succeeded" },
    { id: "L1", type: "local-candidate", candidateType: "host", protocol: "udp" },
    { id: "L2", type: "local-candidate", candidateType: "relay", protocol: "udp" },
  ];
  Object.assign(webRTC.nextPeer, { getStats: async () => new Map(stats.map((stat) => [stat.id, stat])) });
  const transport = makeTransport(room, webRTC);
  await connectTransport(transport, room);
  await flush();
  expect(transport.diagnostics().selectedPair).toBe("relay udp");
  expect(transport.diagnostics().summary).toContain("local: host 0, srflx 0, relay 0, pair relay udp;");
  transport.close();
});

it("builds the first peer with the room's iceServers when the application passes none", async () => {
  const room = new FakeRoom();
  room.iceServers = null;
  const webRTC = new FakeWebRTC();
  const transport = makeTransport(room, webRTC);
  const connecting = transport.connect();
  await flush();
  // Joined, but neither `iceServers` nor `roomState` has arrived: no peer yet.
  expect(webRTC.peers).toHaveLength(0);
  sendRoomIceServers(room, ROOM_TURN("u0"));
  await flush();
  expect(webRTC.peerConfigs).toEqual([{ iceServers: ROOM_TURN("u0"), iceTransportPolicy: "all" }]);
  // The offer does not wait for TURN gathering (PROTOCOL.md section 6).
  expect(offersSent(room)).toHaveLength(1);
  answerLatest(room);
  await connecting;
  transport.close();
});

it("uses Cloudflare's STUN server when the room's first roomState comes with no iceServers", async () => {
  const room = new FakeRoom();
  room.iceServers = null;
  const webRTC = new FakeWebRTC();
  const transport = makeTransport(room, webRTC);
  const connecting = transport.connect();
  await flush();
  expect(webRTC.peers).toHaveLength(0);
  room.state = roomStateFrame("ringing");
  room.emit("roomState", room.state);
  await flush();
  // Cloudflare Realtime's echo example: `iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }]`.
  expect(webRTC.peerConfigs).toEqual([{
    iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
    iceTransportPolicy: "all",
  }]);
  answerLatest(room);
  await connecting;
  transport.close();

  // A room that already sent its roomState and no iceServers: no wait at all.
  const joined = new FakeRoom();
  joined.iceServers = null;
  joined.state = roomStateFrame("in-progress");
  const joinedWebRTC = new FakeWebRTC();
  const again = makeTransport(joined, joinedWebRTC);
  const reconnecting = again.connect();
  await flush();
  expect(joinedWebRTC.peerConfigs.map((config) => config.iceServers)).toEqual([[{ urls: "stun:stun.cloudflare.com:3478" }]]);
  answerLatest(joined);
  await reconnecting;
  again.close();
});

it("rejects connect() and builds no peer when closed while waiting for the room's iceServers", async () => {
  const room = new FakeRoom();
  room.iceServers = null;
  const webRTC = new FakeWebRTC();
  const transport = makeTransport(room, webRTC);
  const connecting = transport.connect();
  await flush();
  transport.close();
  await expect(connecting).rejects.toThrow(/closed before media connected/u);
  expect(webRTC.peers).toHaveLength(0);
});

it("restarts with the room's latest iceServers, sent again on the room's rejoin", async () => {
  vi.useFakeTimers();
  const room = new FakeRoom();
  room.iceServers = ROOM_TURN("u0");
  const webRTC = new FakeWebRTC();
  webRTC.nextPeer.neverConnects = true;
  const transport = makeTransport(room, webRTC);
  const connecting = transport.connect();
  await flush();
  answerLatest(room);
  await flush();
  // The room socket reopened and Relay sent fresh credentials after the new join.
  sendRoomIceServers(room, ROOM_TURN("u1"));
  await vi.advanceTimersByTimeAsync(5_000 + 250);
  await flush();
  expect(webRTC.peers).toHaveLength(2);
  expect(webRTC.peerConfigs.map((config) => config.iceServers[1]?.username)).toEqual(["u0", "u1"]);
  answerLatest(room, "relay-answer-2");
  await connecting;
  transport.close();
});
