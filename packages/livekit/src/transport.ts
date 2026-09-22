import type {
  CallRoom,
  CallRoomCloseEvent,
  CallRoomEndedFrame,
  CallRoomErrorFrame,
  CallRoomOptions,
  CallRoomPublishOfferFrame,
  CallRoomServerAnswerFrame,
  CallRoomStateFrame,
  CallRoomSubscriptionOfferFrame,
  Relay,
} from "@relaymessenger/sdk";

export interface RelayAudioFrame {
  /** Interleaved signed PCM16 samples. */
  samples: Int16Array;
  sampleRate: number;
  channelCount: number;
}

/** @internal Outbound packet counts an engine reports; timestamps are epoch ms. */
export interface RelayAudioSourceStats {
  opusPackets: number;
  rtpPackets: number;
  firstRtpAt: number | undefined;
  lastRtpAt: number | undefined;
  /** RTP packets written in the last 5 s. */
  recentRtpPackets: number;
  /** Encoded packets waiting for the pacer. */
  queued: number;
  /** Whether the 20 ms pacer timer is running. */
  pacerAlive: boolean;
}

/** @internal Inbound packet counts an engine reports; timestamps are epoch ms. */
export interface RelayAudioSinkStats {
  rtpPackets: number;
  decodeFailures: number;
  firstRtpAt: number | undefined;
  lastRtpAt: number | undefined;
  /** RTP packets received in the last 5 s. */
  recentRtpPackets: number;
}

/** @internal */
export interface RelayAudioSourceLike {
  createTrack(): RelayMediaStreamTrackLike;
  onData(data: {
    samples: Int16Array;
    sampleRate: number;
    bitsPerSample: 16;
    channelCount: number;
    numberOfFrames: number;
  }): void;
  /** Engines that own the RTP path report packet counts; `@roamhq/wrtc` does not. */
  stats?(): RelayAudioSourceStats;
}

/** @internal */
export interface RelayAudioSinkLike {
  ondata: ((data: {
    samples: Int16Array;
    sampleRate: number;
    bitsPerSample?: number;
    channelCount?: number;
    numberOfFrames?: number;
  }) => void) | null;
  stop(): void;
  /** Engines that own the RTP path report packet counts; `@roamhq/wrtc` does not. */
  stats?(): RelayAudioSinkStats;
}

/** @internal */
export interface RelayMediaStreamTrackLike {
  kind: string;
  stop(): void;
}

/** @internal */
export interface RelayRtpTransceiverLike {
  readonly mid: string | null;
}

/** @internal */
export interface RelayPeerConnectionLike {
  readonly connectionState: string;
  readonly iceGatheringState: string;
  readonly iceConnectionState?: string;
  readonly signalingState: string;
  readonly localDescription: RTCSessionDescription | null;
  readonly remoteDescription: RTCSessionDescription | null;
  onconnectionstatechange: (() => void) | null;
  /** W3C ICE events; werift and `@roamhq/wrtc` both expose these setters. */
  onicecandidate?: ((event: { candidate?: { candidate: string } | null }) => void) | null;
  onicegatheringstatechange?: ((event?: unknown) => void) | null;
  oniceconnectionstatechange?: (() => void) | null;
  ontrack: ((event: { track: RelayMediaStreamTrackLike }) => void) | null;
  addTransceiver(
    track: RelayMediaStreamTrackLike,
    init: { direction: "sendonly" },
  ): RelayRtpTransceiverLike;
  createOffer(): Promise<RTCSessionDescriptionInit>;
  createAnswer(): Promise<RTCSessionDescriptionInit>;
  setLocalDescription(description: RTCSessionDescriptionInit): Promise<void>;
  setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void>;
  addEventListener(type: "icegatheringstatechange", listener: () => void): void;
  removeEventListener(type: "icegatheringstatechange", listener: () => void): void;
  close(): void;
}

/** Standard `RTCIceServer` shape: STUN or TURN URLs with optional credentials. */
export interface RelayIceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export type RelayIceTransportPolicy = "all" | "relay";

/** @internal Passed by the transport into every engine's `RTCPeerConnection`. */
export interface RelayPeerConnectionConfig {
  iceServers: RelayIceServer[];
  iceTransportPolicy: RelayIceTransportPolicy;
}

/** @internal */
export interface RelayWebRTCFactory {
  createPeerConnection(config?: RelayPeerConnectionConfig): RelayPeerConnectionLike;
  createAudioSource(): RelayAudioSourceLike;
  createAudioSink(track: RelayMediaStreamTrackLike): RelayAudioSinkLike;
}

export type RelayCallEngine = "werift" | "wrtc";

export interface RelayCallTransportOptions {
  relay: Relay;
  callId: string;
  room?: CallRoomOptions;
  /** @internal Supply an already-created Call room in tests. */
  roomClient?: CallRoom;
  /**
   * WebRTC engine. `"werift"` (default) is pure TypeScript plus prebuilt Opus
   * and loads no native binding. `"wrtc"` loads `@roamhq/wrtc` on demand.
   */
  engine?: RelayCallEngine;
  /** @internal Inject another standards-compatible Node WebRTC implementation. */
  webRTC?: RelayWebRTCFactory;
  /**
   * STUN and TURN servers handed to the engine's `RTCPeerConnection`. Defaults
   * to none: Cloudflare's SFU answers with its own host candidates. Set TURN
   * servers when the agent runs behind a NAT or firewall that blocks UDP.
   */
  iceServers?: RelayIceServer[];
  /** `"relay"` forces every candidate through TURN. Defaults to `"all"`. */
  iceTransportPolicy?: RelayIceTransportPolicy;
  /** @internal */
  iceGatheringTimeoutMs?: number;
  /** Maximum wait for the WebRTC peer to become connected. Defaults to 15 seconds. */
  mediaConnectTimeoutMs?: number;
  /** @deprecated Use `mediaConnectTimeoutMs`. */
  connectionTimeoutMs?: number;
  /**
   * Called once per call when outbound audio is queued but no RTP packet has
   * been written for 2 s while media is connected. Receives the diagnostics
   * summary. Defaults to a no-op; nothing is restarted.
   */
  onWarning?: (message: string) => void;
}

/** Packet counts for the other participant's track, as seen by this participant. */
export interface RelayCallInboundDiagnostics {
  /** RTP packets received on the subscribed track. */
  rtpPackets: number;
  /** Opus packets the decoder rejected. */
  decodeFailures: number;
  /** PCM frames handed to the `audio` listeners. */
  frames: number;
  /** ms since `connect()` for the first and last RTP packet; undefined until one arrives. */
  firstPacketAtMs: number | undefined;
  lastPacketAtMs: number | undefined;
  /** RTP packets received in the 5 s before `diagnostics()` was called. */
  recentRtpPackets: number;
}

/** Packet counts for this participant's published track. */
export interface RelayCallOutboundDiagnostics {
  /** PCM slices accepted from the caller and handed to the engine source. */
  frames: number;
  opusPackets: number;
  rtpPackets: number;
  firstPacketAtMs: number | undefined;
  lastPacketAtMs: number | undefined;
  /** RTP packets written in the 5 s before `diagnostics()` was called. */
  recentRtpPackets: number;
  /** Encoded packets waiting for the 20 ms pacer. */
  queued: number;
  /** `undefined` when the engine does not expose its pacer (`wrtc`). */
  pacerAlive: boolean | undefined;
}

/** Room signaling frames counted since `connect()`. */
export interface RelayCallRoomDiagnostics {
  roomStates: number;
  /** Subscription (pull) offers received from the room. */
  offers: number;
  endedReason: string | undefined;
  /** `error` frame messages, in order. */
  errors: string[];
}

/** ICE facts recorded for one call, for logs and for the connect timeout error. */
export interface RelayCallIceDiagnostics {
  /** Local candidates gathered, counted by type. */
  local: { host: number; srflx: number; relay: number; other: number };
  /** Remote candidates from the SFU answer: transport and port only, never the address. */
  remote: Array<{ transport: string; port: number }>;
  /** ICE gathering, ICE connection and peer connection state changes since `connect()`. */
  transitions: Array<{ kind: "gathering" | "ice" | "connection"; state: string; atMs: number }>;
  connected: boolean;
  inbound: RelayCallInboundDiagnostics;
  outbound: RelayCallOutboundDiagnostics;
  room: RelayCallRoomDiagnostics;
  /** One-line rendering of the fields above. */
  summary: string;
}

export interface RelayCallTransportCloseEvent {
  code: number;
  reason: string;
  wasClean: boolean;
}

type TransportEventMap = {
  audio: [RelayAudioFrame];
  connected: [];
  roomState: [CallRoomStateFrame];
  ended: [CallRoomEndedFrame];
  error: [Error];
  close: [RelayCallTransportCloseEvent];
};

type TransportEvent = keyof TransportEventMap;
type TransportListener<K extends TransportEvent> = (...args: TransportEventMap[K]) => void;

const DEFAULT_ICE_GATHERING_TIMEOUT_MS = 10_000;
const DEFAULT_CONNECTION_TIMEOUT_MS = 15_000;
const AUDIO_SLICE_MS = 10;
const STALL_CHECK_MS = 500;
const STALL_AFTER_MS = 2_000;

export class RelayCallTransportError extends Error {
  readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = "RelayCallTransportError";
    if (code !== undefined) this.code = code;
  }
}

const DEFAULT_PEER_CONFIG: RelayPeerConnectionConfig = { iceServers: [], iceTransportPolicy: "all" };

const loadWebRTCFactory = async (engine: RelayCallEngine): Promise<RelayWebRTCFactory> => {
  if (engine === "werift") {
    const { createWeriftWebRTCFactory } = await import("./engine-werift.js");
    return createWeriftWebRTCFactory();
  }
  const wrtc = await import("@roamhq/wrtc");
  return {
    createPeerConnection: (config = DEFAULT_PEER_CONFIG) => new wrtc.RTCPeerConnection({
      bundlePolicy: "max-bundle",
      iceServers: config.iceServers,
      iceTransportPolicy: config.iceTransportPolicy,
    }) as unknown as RelayPeerConnectionLike,
    createAudioSource: () => new wrtc.nonstandard.RTCAudioSource() as unknown as RelayAudioSourceLike,
    createAudioSink: (track) => new wrtc.nonstandard.RTCAudioSink(
      track as unknown as MediaStreamTrack,
    ) as unknown as RelayAudioSinkLike,
  };
};

/** `candidate:<foundation> <component> <transport> <priority> <address> <port> typ <type> ...` (RFC 5245 §15.1). */
const parseCandidate = (line: string): { transport: string; port: number; type: string } | undefined => {
  const match = /candidate:\S+\s+\d+\s+(\S+)\s+\d+\s+\S+\s+(\d+)\s+typ\s+(\S+)/i.exec(line);
  if (!match) return undefined;
  return { transport: match[1]!.toLowerCase(), port: Number(match[2]), type: match[3]!.toLowerCase() };
};

const seconds = (milliseconds: number): string => `${(milliseconds / 1000).toFixed(1)}s`;

const summarizeIce = (diagnostics: Omit<RelayCallIceDiagnostics, "summary">): string => {
  const { local, remote, transitions, connected } = diagnostics;
  const localPart = `local: host ${local.host}, srflx ${local.srflx}, relay ${local.relay}`
    + (local.other ? `, other ${local.other}` : "");
  const remotePart = remote.length
    ? `remote: ${remote.map((candidate) => `${candidate.transport} ${candidate.port}`).join(", ")}`
    : "remote: none";
  const states: string[] = [];
  let lastGathering = "new";
  for (const transition of transitions) {
    if (transition.kind === "gathering") {
      states.push(`${lastGathering}\u2192${transition.state} ${seconds(transition.atMs)}`);
      lastGathering = transition.state;
    } else if (transition.kind === "ice") {
      states.push(`ice ${transition.state} ${seconds(transition.atMs)}`);
    } else {
      states.push(`${transition.state} ${seconds(transition.atMs)}`);
    }
  }
  if (!connected) states.push("no connected");
  return `${localPart}; ${remotePart}; states: ${states.join(", ")}`;
};

const span = (first: number | undefined, last: number | undefined): string =>
  first === undefined || last === undefined ? "no packets" : `first ${seconds(first)} last ${seconds(last)}`;

const summarizeInbound = (inbound: RelayCallInboundDiagnostics): string =>
  `in: ${inbound.rtpPackets} rtp, ${inbound.decodeFailures} bad, ${inbound.frames} frames, `
  + `${span(inbound.firstPacketAtMs, inbound.lastPacketAtMs)}, ${inbound.recentRtpPackets}/5s`;

const summarizeOutbound = (outbound: RelayCallOutboundDiagnostics): string =>
  `out: ${outbound.frames} frames, ${outbound.opusPackets} opus, ${outbound.rtpPackets} rtp, `
  + `${span(outbound.firstPacketAtMs, outbound.lastPacketAtMs)}, ${outbound.recentRtpPackets}/5s, `
  + `queue ${outbound.queued}, pacer ${
    outbound.pacerAlive === undefined ? "n/a" : outbound.pacerAlive ? "alive" : "idle"
  }`;

const summarizeRoom = (room: RelayCallRoomDiagnostics): string => {
  const parts = [`${room.roomStates} roomState`, `${room.offers} offer`];
  if (room.endedReason !== undefined) parts.push(`ended ${room.endedReason}`);
  if (room.errors.length) parts.push(`error ${room.errors.map((text) => JSON.stringify(text)).join(", ")}`);
  return `room: ${parts.join(", ")}`;
};

const summarize = (diagnostics: Omit<RelayCallIceDiagnostics, "summary">): string =>
  `${summarizeIce(diagnostics)}; ${summarizeInbound(diagnostics.inbound)}; `
  + `${summarizeOutbound(diagnostics.outbound)}; ${summarizeRoom(diagnostics.room)}`;

const cloneSamples = (samples: Int16Array): Int16Array => {
  const copy = new Int16Array(samples.length);
  copy.set(samples);
  return copy;
};

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });

/**
 * Provider-neutral Node WebRTC bridge for Relay Call rooms.
 *
 * The class owns Relay media negotiation internally. Higher-level adapters only
 * exchange PCM16 frames and call lifecycle events.
 */
export class RelayCallTransport {
  readonly #room: CallRoom;
  readonly #providedFactory: RelayWebRTCFactory | undefined;
  readonly #engine: RelayCallEngine;
  readonly #iceGatheringTimeoutMs: number;
  readonly #connectionTimeoutMs: number;
  readonly #peerConfig: RelayPeerConnectionConfig;
  readonly #onWarning: (message: string) => void;
  #connectStartedAt = 0;
  #inboundFrames = 0;
  #outboundFrames = 0;
  #roomStates = 0;
  #roomOffers = 0;
  #endedReason: string | undefined;
  readonly #roomErrors: string[] = [];
  /** Engine stats frozen when media shuts down, so diagnostics survive the call's end. */
  #finalSinkStats: RelayAudioSinkStats | undefined;
  #finalSourceStats: RelayAudioSourceStats | undefined;
  #stallTimer: NodeJS.Timeout | undefined;
  #stallSince: number | undefined;
  #stallWarned = false;
  #iceLocal = { host: 0, srflx: 0, relay: 0, other: 0 };
  #iceRemote: Array<{ transport: string; port: number }> = [];
  #iceTransitions: RelayCallIceDiagnostics["transitions"] = [];
  readonly #listeners = new Map<TransportEvent, Set<(...args: any[]) => void>>();
  #factory: RelayWebRTCFactory | undefined;
  #peer: RelayPeerConnectionLike | undefined;
  #audioSource: RelayAudioSourceLike | undefined;
  #localTrack: RelayMediaStreamTrackLike | undefined;
  #remoteSink: RelayAudioSinkLike | undefined;
  #publishTransceiver: RelayRtpTransceiverLike | undefined;
  #publishFrame: CallRoomPublishOfferFrame | undefined;
  #initialAnswerSdp: string | undefined;
  #negotiationTail: Promise<void> = Promise.resolve();
  #outputTail: Promise<void> = Promise.resolve();
  #audioGeneration = 0;
  #reportedConnected = false;
  #readySettled = false;
  #readyResolve: (() => void) | undefined;
  #readyReject: ((error: Error) => void) | undefined;
  readonly #ready: Promise<void>;
  #handlersAttached = false;
  #closed = false;

  constructor(options: RelayCallTransportOptions) {
    if (!options.callId.trim()) throw new Error("callId is required.");
    this.#room = options.roomClient ?? options.relay.calls.room(options.callId, options.room);
    this.#providedFactory = options.webRTC;
    this.#engine = options.engine ?? "werift";
    this.#onWarning = options.onWarning ?? (() => undefined);
    if (this.#engine !== "werift" && this.#engine !== "wrtc") {
      throw new Error('engine must be "werift" or "wrtc".');
    }
    this.#iceGatheringTimeoutMs = options.iceGatheringTimeoutMs ?? DEFAULT_ICE_GATHERING_TIMEOUT_MS;
    this.#connectionTimeoutMs = options.mediaConnectTimeoutMs
      ?? options.connectionTimeoutMs
      ?? DEFAULT_CONNECTION_TIMEOUT_MS;
    const policy = options.iceTransportPolicy ?? "all";
    if (policy !== "all" && policy !== "relay") {
      throw new Error('iceTransportPolicy must be "all" or "relay".');
    }
    this.#peerConfig = {
      iceServers: (options.iceServers ?? []).map((server) => ({
        urls: Array.isArray(server.urls) ? [...server.urls] : server.urls,
        ...(server.username === undefined ? {} : { username: server.username }),
        ...(server.credential === undefined ? {} : { credential: server.credential }),
      })),
      iceTransportPolicy: policy,
    };
    if (!Number.isFinite(this.#iceGatheringTimeoutMs) || this.#iceGatheringTimeoutMs <= 0) {
      throw new Error("iceGatheringTimeoutMs must be greater than zero.");
    }
    if (!Number.isFinite(this.#connectionTimeoutMs) || this.#connectionTimeoutMs <= 0) {
      throw new Error("mediaConnectTimeoutMs must be greater than zero.");
    }
    this.#ready = new Promise<void>((resolve, reject) => {
      this.#readyResolve = resolve;
      this.#readyReject = reject;
    });
    void this.#ready.catch(() => undefined);
  }

  on<K extends TransportEvent>(event: K, listener: TransportListener<K>): this {
    let listeners = this.#listeners.get(event);
    if (!listeners) {
      listeners = new Set();
      this.#listeners.set(event, listeners);
    }
    listeners.add(listener as (...args: any[]) => void);
    return this;
  }

  off<K extends TransportEvent>(event: K, listener: TransportListener<K>): this {
    this.#listeners.get(event)?.delete(listener as (...args: any[]) => void);
    return this;
  }

  async connect(): Promise<void> {
    if (this.#closed) throw new Error("Relay Call transport is closed.");
    this.#attachRoomHandlers();
    await this.#room.connect();
    if (this.#peer) {
      await this.#waitForConnection();
      return;
    }
    this.#factory = this.#providedFactory ?? await loadWebRTCFactory(this.#engine);
    this.#audioSource = this.#factory.createAudioSource();
    this.#localTrack = this.#audioSource.createTrack();
    if (this.#localTrack.kind !== "audio") {
      throw new RelayCallTransportError("The WebRTC binding created a non-audio Relay track.");
    }
    this.#connectStartedAt = Date.now();
    const peer = this.#factory.createPeerConnection(this.#peerConfig);
    this.#peer = peer;
    this.#publishTransceiver = peer.addTransceiver(this.#localTrack, { direction: "sendonly" });
    this.#observeIce(peer);
    peer.onconnectionstatechange = () => {
      this.#recordTransition("connection", peer.connectionState);
      this.#connectionStateChanged();
    };
    peer.ontrack = (event) => this.#remoteTrack(event.track);
    try {
      await this.#publishLocalAudio();
      await this.#waitForConnection();
    } catch (error) {
      this.close();
      throw error;
    }
  }

  /** Replace only the room signaling socket and replay the identical publication. */
  async reconnect(): Promise<void> {
    if (this.#closed) throw new Error("Relay Call transport is closed.");
    if (!this.#publishFrame) throw new Error("Relay Call transport is not connected.");
    await this.#room.reconnect();
    this.#room.send(this.#publishFrame);
  }

  /**
   * ICE candidates, state transitions, packet counts in both directions and
   * room frame counts recorded for this call, with a one-line summary.
   */
  diagnostics(): RelayCallIceDiagnostics {
    const snapshot = {
      local: { ...this.#iceLocal },
      remote: this.#iceRemote.map((candidate) => ({ ...candidate })),
      transitions: this.#iceTransitions.map((transition) => ({ ...transition })),
      connected: this.#reportedConnected,
      inbound: this.#inboundDiagnostics(),
      outbound: this.#outboundDiagnostics(),
      room: {
        roomStates: this.#roomStates,
        offers: this.#roomOffers,
        endedReason: this.#endedReason,
        errors: [...this.#roomErrors],
      },
    };
    return { ...snapshot, summary: summarize(snapshot) };
  }

  #sinceConnect(epochMs: number | undefined): number | undefined {
    return epochMs === undefined ? undefined : epochMs - this.#connectStartedAt;
  }

  #inboundDiagnostics(): RelayCallInboundDiagnostics {
    const stats = this.#remoteSink?.stats?.() ?? this.#finalSinkStats;
    return {
      rtpPackets: stats?.rtpPackets ?? 0,
      decodeFailures: stats?.decodeFailures ?? 0,
      frames: this.#inboundFrames,
      firstPacketAtMs: this.#sinceConnect(stats?.firstRtpAt),
      lastPacketAtMs: this.#sinceConnect(stats?.lastRtpAt),
      recentRtpPackets: stats?.recentRtpPackets ?? 0,
    };
  }

  #outboundDiagnostics(): RelayCallOutboundDiagnostics {
    const stats = this.#audioSource?.stats?.() ?? this.#finalSourceStats;
    return {
      frames: this.#outboundFrames,
      opusPackets: stats?.opusPackets ?? 0,
      rtpPackets: stats?.rtpPackets ?? 0,
      firstPacketAtMs: this.#sinceConnect(stats?.firstRtpAt),
      lastPacketAtMs: this.#sinceConnect(stats?.lastRtpAt),
      recentRtpPackets: stats?.recentRtpPackets ?? 0,
      queued: stats?.queued ?? 0,
      pacerAlive: stats?.pacerAlive,
    };
  }

  /**
   * Outbound stall guard: audio is queued for the pacer but no RTP packet has
   * left for 2 s while connected. Warns once with the summary; restarts nothing.
   */
  #checkStall(): void {
    if (this.#stallWarned || !this.#reportedConnected) return;
    const stats = this.#audioSource?.stats?.();
    if (!stats || stats.queued === 0) {
      this.#stallSince = undefined;
      return;
    }
    const now = Date.now();
    const idleSince = stats.lastRtpAt ?? (this.#stallSince ??= now);
    if (now - idleSince < STALL_AFTER_MS) return;
    this.#stallWarned = true;
    this.#stopStallGuard();
    this.#onWarning(`Relay outbound audio stalled (${this.diagnostics().summary})`);
  }

  #startStallGuard(): void {
    if (this.#stallTimer) return;
    this.#stallTimer = setInterval(() => this.#checkStall(), STALL_CHECK_MS);
    this.#stallTimer.unref?.();
  }

  #stopStallGuard(): void {
    if (!this.#stallTimer) return;
    clearInterval(this.#stallTimer);
    this.#stallTimer = undefined;
  }

  /**
   * Feed interleaved PCM16 audio into Relay. Frames are split into 10 ms WebRTC
   * source slices and paced in real time, so adapters may push larger chunks.
   */
  writeAudio(frame: RelayAudioFrame): Promise<void> {
    if (this.#closed) return Promise.reject(new Error("Relay Call transport is closed."));
    if (!this.#audioSource) return Promise.reject(new Error("Relay Call transport is not connected."));
    if (!Number.isInteger(frame.sampleRate) || frame.sampleRate <= 0 || frame.sampleRate % 100 !== 0) {
      return Promise.reject(new Error("Relay audio sampleRate must be a positive multiple of 100."));
    }
    if (!Number.isInteger(frame.channelCount) || frame.channelCount <= 0) {
      return Promise.reject(new Error("Relay audio channelCount must be a positive integer."));
    }
    if (frame.samples.length % frame.channelCount !== 0) {
      return Promise.reject(new Error("Relay audio samples must contain complete interleaved frames."));
    }
    const captured: RelayAudioFrame = {
      samples: cloneSamples(frame.samples),
      sampleRate: frame.sampleRate,
      channelCount: frame.channelCount,
    };
    const generation = this.#audioGeneration;
    const queued = this.#outputTail.then(() => this.#writeAudio(captured, generation));
    this.#outputTail = queued.catch(() => undefined);
    return queued;
  }

  /** Drop queued outgoing PCM. At most one already-submitted 10 ms slice remains. */
  clearAudio(): void {
    this.#audioGeneration += 1;
  }

  setMuted(muted: boolean): void {
    this.#room.userUpdate({ muted });
  }

  end(): void {
    this.#room.end();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#rejectReady(new RelayCallTransportError("Relay Call transport closed before media connected."));
    this.clearAudio();
    this.#shutdownMedia();
    this.#room.close();
  }

  async #publishLocalAudio(): Promise<void> {
    const peer = this.#requirePeer();
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    await this.#waitForIceGathering(peer);
    const description = this.#localDescription("offer");
    const mid = this.#publishTransceiver?.mid;
    if (!mid) throw new RelayCallTransportError("Relay audio publication has no WebRTC MID.");
    this.#publishFrame = {
      type: "offer",
      session_description: description,
      tracks: [{ mid, name: "audio" }],
    };
    this.#room.send(this.#publishFrame);
  }

  #attachRoomHandlers(): void {
    if (this.#handlersAttached) return;
    this.#handlersAttached = true;
    this.#room.on("answer", (frame: CallRoomServerAnswerFrame) => {
      this.#queueNegotiation(() => this.#serverAnswer(frame));
    });
    this.#room.on("offer", (frame: CallRoomSubscriptionOfferFrame) => {
      this.#roomOffers += 1;
      this.#queueNegotiation(() => this.#serverOffer(frame));
    });
    this.#room.on("roomState", (frame: CallRoomStateFrame) => {
      this.#roomStates += 1;
      this.#emit("roomState", frame);
    });
    this.#room.on("error", (error: CallRoomErrorFrame | Error) => {
      if (error instanceof Error) {
        this.#rejectReady(error);
        this.#emit("error", error);
      } else this.#serverError(error);
    });
    this.#room.on("ended", (frame: CallRoomEndedFrame) => {
      this.#endedReason = frame.reason;
      this.#rejectReady(new RelayCallTransportError(`Relay Call ended before media connected (${frame.reason}).`));
      this.clearAudio();
      this.#shutdownMedia();
      this.#emit("ended", frame);
    });
    this.#room.on("close", (event: CallRoomCloseEvent) => {
      if (!this.#reportedConnected) {
        this.#rejectReady(new RelayCallTransportError(
          `Relay Call room closed before media connected (${event.code}).`,
        ));
      }
      this.#emit("close", event);
    });
  }

  #queueNegotiation(work: () => Promise<void>): void {
    const run = this.#negotiationTail.then(work);
    this.#negotiationTail = run.catch((error: unknown) => {
      const parsed = error instanceof Error ? error : new Error(String(error));
      this.#rejectReady(parsed);
      this.#emit("error", parsed);
    });
  }

  async #serverAnswer(frame: CallRoomServerAnswerFrame): Promise<void> {
    const peer = this.#requirePeer();
    const sdp = frame.session_description.sdp;
    // Reconnecting the signaling socket replays the exact initial offer. Relay
    // returns its cached answer; applying that answer again in stable state is
    // invalid WebRTC signaling, so recognize and ignore the replay.
    if (peer.signalingState === "stable" && this.#initialAnswerSdp === sdp) return;
    if (this.#initialAnswerSdp === undefined) this.#recordRemoteCandidates(sdp);
    await peer.setRemoteDescription(frame.session_description);
    this.#initialAnswerSdp ??= sdp;
  }

  async #serverOffer(frame: CallRoomSubscriptionOfferFrame): Promise<void> {
    const peer = this.#requirePeer();
    await peer.setRemoteDescription(frame.session_description);
    const answer = await peer.createAnswer();
    await peer.setLocalDescription(answer);
    await this.#waitForIceGathering(peer);
    this.#room.send({ type: "answer", session_description: this.#localDescription("answer") });
  }

  #serverError(frame: CallRoomErrorFrame): void {
    this.#roomErrors.push(frame.message);
    const error = new RelayCallTransportError(frame.message, frame.code);
    this.#rejectReady(error);
    this.#emit("error", error);
  }

  #connectionStateChanged(): void {
    const state = this.#peer?.connectionState;
    if (state === "connected" && !this.#reportedConnected) {
      this.#reportedConnected = true;
      try {
        this.#room.connected();
        this.#resolveReady();
        this.#startStallGuard();
        this.#emit("connected");
      } catch (error) {
        const parsed = error instanceof Error ? error : new Error(String(error));
        this.#rejectReady(parsed);
        this.#emit("error", parsed);
      }
    } else if (state === "failed") {
      const error = new RelayCallTransportError("Relay WebRTC connection failed.");
      this.#rejectReady(error);
      this.#emit("error", error);
    }
  }

  #remoteTrack(track: RelayMediaStreamTrackLike): void {
    if (track.kind !== "audio" || !this.#factory) return;
    this.#remoteSink?.stop();
    const sink = this.#factory.createAudioSink(track);
    this.#remoteSink = sink;
    sink.ondata = (data) => {
      if (this.#closed || this.#remoteSink !== sink) return;
      const channelCount = data.channelCount ?? 1;
      if (data.bitsPerSample !== undefined && data.bitsPerSample !== 16) {
        this.#emit("error", new RelayCallTransportError(
          `Relay WebRTC delivered unsupported ${data.bitsPerSample}-bit audio.`,
        ));
        return;
      }
      this.#inboundFrames += 1;
      this.#emit("audio", {
        samples: cloneSamples(data.samples),
        sampleRate: data.sampleRate,
        channelCount,
      });
    };
  }

  async #writeAudio(frame: RelayAudioFrame, generation: number): Promise<void> {
    const source = this.#audioSource;
    if (!source || generation !== this.#audioGeneration) return;
    const samplesPerChannel = frame.sampleRate / 100;
    const sliceSamples = samplesPerChannel * frame.channelCount;
    for (let offset = 0; offset < frame.samples.length; offset += sliceSamples) {
      if (this.#closed || generation !== this.#audioGeneration) return;
      const remaining = Math.min(sliceSamples, frame.samples.length - offset);
      const samples = new Int16Array(sliceSamples);
      samples.set(frame.samples.subarray(offset, offset + remaining));
      source.onData({
        samples,
        sampleRate: frame.sampleRate,
        bitsPerSample: 16,
        channelCount: frame.channelCount,
        numberOfFrames: samplesPerChannel,
      });
      this.#outboundFrames += 1;
      await delay(AUDIO_SLICE_MS);
    }
  }

  async #waitForIceGathering(peer: RelayPeerConnectionLike): Promise<void> {
    if (peer.iceGatheringState === "complete") return;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new RelayCallTransportError("Timed out gathering Relay WebRTC ICE candidates."));
      }, this.#iceGatheringTimeoutMs);
      timeout.unref?.();
      const changed = (): void => {
        if (peer.iceGatheringState !== "complete") return;
        cleanup();
        resolve();
      };
      const cleanup = (): void => {
        clearTimeout(timeout);
        peer.removeEventListener("icegatheringstatechange", changed);
      };
      peer.addEventListener("icegatheringstatechange", changed);
      changed();
    });
  }

  async #waitForConnection(): Promise<void> {
    if (this.#reportedConnected) return;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new RelayCallTransportError(
          `Timed out connecting Relay WebRTC media (${this.diagnostics().summary})`,
        ));
      }, this.#connectionTimeoutMs);
      timeout.unref?.();
      this.#ready.then(
        () => {
          clearTimeout(timeout);
          resolve();
        },
        (error: unknown) => {
          clearTimeout(timeout);
          reject(error);
        },
      );
    });
  }

  /**
   * werift emits these as W3C-style handler calls (peerConnection.js:314-341:
   * `onicegatheringstatechange`, `oniceconnectionstatechange`,
   * `onconnectionstatechange`, `onicecandidate` with `{ candidate }`).
   */
  #observeIce(peer: RelayPeerConnectionLike): void {
    peer.onicecandidate = (event) => {
      const line = event?.candidate?.candidate;
      if (!line) return;
      const type = parseCandidate(line)?.type;
      if (type === "host" || type === "srflx" || type === "relay") this.#iceLocal[type] += 1;
      else this.#iceLocal.other += 1;
    };
    peer.onicegatheringstatechange = () => this.#recordTransition("gathering", peer.iceGatheringState);
    peer.oniceconnectionstatechange = () => {
      if (peer.iceConnectionState !== undefined) this.#recordTransition("ice", peer.iceConnectionState);
    };
  }

  #recordTransition(kind: RelayCallIceDiagnostics["transitions"][number]["kind"], state: string): void {
    this.#iceTransitions.push({ kind, state, atMs: Date.now() - this.#connectStartedAt });
  }

  #recordRemoteCandidates(sdp: string): void {
    for (const line of sdp.split(/\r?\n/)) {
      if (!line.startsWith("a=candidate:")) continue;
      const parsed = parseCandidate(line);
      if (parsed) this.#iceRemote.push({ transport: parsed.transport, port: parsed.port });
    }
  }

  #resolveReady(): void {
    if (this.#readySettled) return;
    this.#readySettled = true;
    this.#readyResolve?.();
  }

  #rejectReady(error: Error): void {
    if (this.#readySettled) return;
    this.#readySettled = true;
    this.#readyReject?.(error);
  }

  #localDescription<T extends "offer" | "answer">(type: T): { type: T; sdp: string } {
    const local = this.#requirePeer().localDescription;
    if (!local || local.type !== type || !local.sdp) {
      throw new RelayCallTransportError(`Relay WebRTC did not produce a complete ${type} SDP.`);
    }
    return { type, sdp: local.sdp };
  }

  #requirePeer(): RelayPeerConnectionLike {
    if (!this.#peer) throw new Error("Relay Call transport is not connected.");
    return this.#peer;
  }

  #shutdownMedia(): void {
    this.#stopStallGuard();
    this.#finalSinkStats ??= this.#remoteSink?.stats?.();
    this.#finalSourceStats ??= this.#audioSource?.stats?.();
    this.#remoteSink?.stop();
    this.#remoteSink = undefined;
    this.#localTrack?.stop();
    this.#localTrack = undefined;
    this.#peer?.close();
    this.#peer = undefined;
    this.#audioSource = undefined;
  }

  #emit<K extends TransportEvent>(event: K, ...args: TransportEventMap[K]): void {
    for (const listener of this.#listeners.get(event) ?? []) {
      try { listener(...args); } catch { /* adapters own listener failures */ }
    }
  }
}
