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

type CallStatus = CallRoomStateFrame["call"]["status"];

export interface RelayAudioFrame {
  /** Interleaved signed PCM16 samples. */
  samples: Int16Array;
  sampleRate: number;
  channelCount: number;
}

/** @internal Outbound packet counts an engine reports; timestamps are epoch ms. */
export interface RelayAudioSourceStats {
  opusPackets: number;
  /** RTP packets carrying application audio. */
  rtpPackets: number;
  /** RTP packets carrying the silence frame sent while nothing is queued. */
  silencePackets: number;
  /** First and last RTP packet of either kind. */
  firstRtpAt: number | undefined;
  lastRtpAt: number | undefined;
  /** RTP packets of either kind written in the last 5 s. */
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
  /**
   * The peer is connected: from now until the track stops, write one packet
   * every 20 ms, silence when nothing is queued, as a live microphone does.
   * Idempotent. `@roamhq/wrtc` has no such clock (see `WrtcAudioSource`).
   */
  start?(): void;
  /** Milliseconds accepted by `onData` but not yet written to RTP (encoded queue plus any un-encoded remainder). */
  queuedMs?(): number;
  /** Resolves once everything accepted so far has been written to RTP and the pacer is idle. */
  waitForDrain?(): Promise<void>;
  /** Drop audio accepted but not yet written to RTP. */
  clear?(): void;
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

/**
 * Returns the ICE servers for one peer connection. Called before the first
 * peer and again before every restart, so short-lived TURN credentials can be
 * minted per attempt (PartyTracks: a reconnect "will trigger new sessionId,
 * new ice server credentials and a new peerConnection").
 */
export type RelayIceServersProvider = (attempt: {
  /** 0 for the first peer, then 1, 2, ... for each restart. */
  restarts: number;
}) => RelayIceServer[] | Promise<RelayIceServer[]>;

/** Why the transport replaced its peer connection with a new SFU session. */
export type RelayCallRestartReason = "timeout" | "failed" | "disconnected" | "error";

export interface RelayCallRestartEvent {
  reason: RelayCallRestartReason;
  /** `diagnostics().summary` of the session being replaced, taken as it was given up. */
  summary: string;
  /** Restarts since `connect()`, this one included. */
  restarts: number;
  /** Backoff waited before the new peer was built. */
  delayMs: number;
}

/**
 * PCM format the engine decodes the remote participant's Opus into. The values
 * are the ones libopus decodes to (`@evan/opus` lib.d.ts: `channels?: 1 | 2`,
 * `sample_rate?: 8000 | 12000 | 16000 | 24000 | 48000`); the decoder itself
 * resamples and downmixes, so no PCM is converted by hand.
 */
export interface RelayInboundAudioFormat {
  sampleRate: 8000 | 12000 | 16000 | 24000 | 48000;
  channelCount: 1 | 2;
}

/** Opus's native rate and Relay's wire channel count. */
export const DEFAULT_INBOUND_AUDIO: Readonly<RelayInboundAudioFormat> = Object.freeze({
  sampleRate: 48_000,
  channelCount: 2,
});

const INBOUND_SAMPLE_RATES: ReadonlySet<number> = new Set([8_000, 12_000, 16_000, 24_000, 48_000]);

/** @internal Passed by the transport into every engine's `RTCPeerConnection`. */
export interface RelayPeerConnectionConfig {
  iceServers: RelayIceServer[];
  iceTransportPolicy: RelayIceTransportPolicy;
}

/** @internal */
export interface RelayWebRTCFactory {
  createPeerConnection(config?: RelayPeerConnectionConfig): RelayPeerConnectionLike;
  createAudioSource(): RelayAudioSourceLike;
  createAudioSink(track: RelayMediaStreamTrackLike, format: RelayInboundAudioFormat): RelayAudioSinkLike;
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
   * servers when the agent runs behind a NAT or firewall that blocks UDP. A
   * function is called before every peer connection, restarts included, so
   * it can mint fresh TURN credentials each time.
   */
  iceServers?: RelayIceServer[] | RelayIceServersProvider;
  /** `"relay"` forces every candidate through TURN. Defaults to `"all"`. */
  iceTransportPolicy?: RelayIceTransportPolicy;
  /** @internal */
  iceGatheringTimeoutMs?: number;
  /**
   * How long one SFU session has, after its answer is applied, to reach
   * `connected` before the transport restarts onto a new session. Defaults to
   * 5 seconds. `connect()` itself has no deadline: it waits through restarts
   * until media connects, the Call ends, `close()` is called, or its signal aborts.
   */
  sessionConnectTimeoutMs?: number;
  /** @deprecated Use `sessionConnectTimeoutMs`; now the per-session wait, not a `connect()` deadline. */
  mediaConnectTimeoutMs?: number;
  /** @deprecated Use `sessionConnectTimeoutMs`. */
  connectionTimeoutMs?: number;
  /**
   * PCM format of the `audio` events: the Opus decoder decodes the remote
   * track straight to this rate and channel count. Defaults to 48 kHz stereo.
   * The `"wrtc"` engine delivers libwebrtc's own format and accepts only the default.
   */
  inboundAudio?: RelayInboundAudioFormat;
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
  /** RTP packets carrying the caller's audio. */
  rtpPackets: number;
  /** RTP packets carrying Opus silence, written while nothing was queued. */
  silencePackets: number;
  /** ms since `connect()` for the first and last RTP packet of either kind. */
  firstPacketAtMs: number | undefined;
  lastPacketAtMs: number | undefined;
  /** RTP packets of either kind written in the 5 s before `diagnostics()` was called. */
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
  /** Peer connections replaced by a new SFU session since `connect()`. */
  restarts: number;
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
  /** A new peer connection published on a new SFU session; audio continues on it. */
  restarted: [RelayCallRestartEvent];
  roomState: [CallRoomStateFrame];
  /** The person's camera started (`true`) or stopped (`false`) sending, from `roomState`. */
  remoteVideo: [boolean];
  /**
   * Once per call: the person's audio has reached this peer (first inbound
   * frame on the pulled track) and `roomState` shows the person connected. The
   * room pulls both directions together, so from here the person hears what is
   * written; start speaking after this, as LiveKit Agents start a session once
   * the participant is in the room.
   */
  peerAudio: [];
  ended: [CallRoomEndedFrame];
  error: [Error];
  close: [RelayCallTransportCloseEvent];
};

type TransportEvent = keyof TransportEventMap;
type TransportListener<K extends TransportEvent> = (...args: TransportEventMap[K]) => void;

const DEFAULT_ICE_GATHERING_TIMEOUT_MS = 10_000;
const AUDIO_SLICE_MS = 10;
const STALL_CHECK_MS = 500;
const STALL_AFTER_MS = 2_000;

/**
 * Restart rule, copied from PartyTracks and Cloudflare (PROTOCOL.md section 4):
 * not `connected` 5 s after the SFU answer (Cloudflare's echo example waits
 * 5000 ms; SFU operations block up to 5 s awaiting `connected`), `failed`, or
 * `disconnected` for 7 s (PartyTracks.ts `timeoutSeconds = 7`). Backoff 250 ms
 * x1.1 per attempt, capped at 10 s (PartyTracks `retryWithBackoff`
 * `backoffFactor: 1.1`, rxjs-helpers.ts defaults). werift never reports
 * `failed` on a session whose checks go unanswered (ice.js:983-986), so the
 * 5 s timer is the trigger that fires in practice.
 */
export const RESTART_CONNECT_TIMEOUT_MS = 5_000;
export const RESTART_DISCONNECTED_MS = 7_000;
export const RESTART_INITIAL_DELAY_MS = 250;
export const RESTART_BACKOFF_FACTOR = 1.1;
export const RESTART_MAX_DELAY_MS = 10_000;

/**
 * Backoff before restart number `attempt` (1-based) counted since the last
 * session that connected. PartyTracks passes `resetOnSuccess: true` to rxjs
 * `retry` (rxjs-helpers.ts:18, :39); this transport reads "success" as a
 * session reaching `connected`.
 */
export const restartDelayMs = (attempt: number): number =>
  Math.min(RESTART_INITIAL_DELAY_MS * RESTART_BACKOFF_FACTOR ** (attempt - 1), RESTART_MAX_DELAY_MS);

const ACTIVE_CALL_STATUSES: ReadonlySet<CallStatus> = new Set<CallStatus>(["ringing", "in-progress"]);

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
    createAudioSource: () => new WrtcAudioSource(
      new wrtc.nonstandard.RTCAudioSource() as unknown as RelayAudioSourceLike,
    ),
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
  + `silence ${outbound.silencePackets}, `
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
  + `${summarizeOutbound(diagnostics.outbound)}; ${summarizeRoom(diagnostics.room)}`
  + (diagnostics.restarts ? `; restarts ${diagnostics.restarts}` : "");

const copyIceServers = (servers: readonly RelayIceServer[]): RelayIceServer[] =>
  servers.map((server) => ({
    urls: Array.isArray(server.urls) ? [...server.urls] : server.urls,
    ...(server.username === undefined ? {} : { username: server.username }),
    ...(server.credential === undefined ? {} : { credential: server.credential }),
  }));

const cloneSamples = (samples: Int16Array): Int16Array => {
  const copy = new Int16Array(samples.length);
  copy.set(samples);
  return copy;
};

/**
 * `@roamhq/wrtc`'s `RTCAudioSource` plays each 10 ms slice through libwebrtc's
 * own clock and exposes no queue, so this wrapper estimates it from wall time:
 * queued = accepted since the run started minus the time elapsed. Best effort;
 * the werift engine (the default) reports its real queue.
 *
 * It sends no silence of its own. The source has no timer: `onData` hands the
 * slice to the track's sinks and returns (`RTCAudioSource::OnData` ->
 * `PushData`, node-webrtc src/interfaces/rtc_audio_source.cc and
 * rtc_audio_source.hh, the repository @roamhq/wrtc 0.10.0 is published
 * from), so libwebrtc receives audio only while the caller writes it, and
 * this wrapper has no `start()`. What libwebrtc puts on the wire between
 * writes was not measured; a caller of this
 * engine that needs the track to carry data between utterances writes
 * silence itself.
 */
class WrtcAudioSource implements RelayAudioSourceLike {
  readonly #inner: RelayAudioSourceLike;
  #runStartedAt = 0;
  #runAcceptedMs = 0;

  constructor(inner: RelayAudioSourceLike) {
    this.#inner = inner;
  }

  createTrack(): RelayMediaStreamTrackLike {
    return this.#inner.createTrack();
  }

  onData(data: Parameters<RelayAudioSourceLike["onData"]>[0]): void {
    const now = Date.now();
    if (this.queuedMs() === 0) {
      this.#runStartedAt = now;
      this.#runAcceptedMs = 0;
    }
    this.#runAcceptedMs += (data.numberOfFrames / data.sampleRate) * 1_000;
    this.#inner.onData(data);
  }

  queuedMs(): number {
    if (this.#runAcceptedMs === 0) return 0;
    return Math.max(0, this.#runAcceptedMs - (Date.now() - this.#runStartedAt));
  }

  async waitForDrain(): Promise<void> {
    const remaining = this.queuedMs();
    if (remaining > 0) await delay(remaining);
  }

  clear(): void {
    // libwebrtc keeps slices already handed over; only the estimate can be reset.
    this.#runAcceptedMs = 0;
  }
}

/** werift's `close()` is async; a rejection there must not become an unhandled one. */
const closePeer = (peer: RelayPeerConnectionLike): void => {
  try {
    void Promise.resolve(peer.close() as unknown).catch(() => undefined);
  } catch { /* already closed */ }
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
 * exchange PCM16 frames and call lifecycle events. When an SFU session never
 * connects or dies, the transport builds a new peer connection on a new
 * session (PROTOCOL.md section 4); the audio source and the `audio` events
 * carry on across the swap, so adapters only hear silence.
 */
export class RelayCallTransport {
  readonly #room: CallRoom;
  readonly #providedFactory: RelayWebRTCFactory | undefined;
  readonly #engine: RelayCallEngine;
  readonly #iceGatheringTimeoutMs: number;
  readonly #sessionConnectTimeoutMs: number;
  readonly #iceServers: RelayIceServer[] | RelayIceServersProvider;
  readonly #iceTransportPolicy: RelayIceTransportPolicy;
  readonly #inboundAudio: RelayInboundAudioFormat;
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
  /** Inbound counts from sinks of peers already replaced by a restart. */
  #retiredSinkStats: RelayAudioSinkStats | undefined;
  #stallTimer: NodeJS.Timeout | undefined;
  #stallSince: number | undefined;
  #stallWarned = false;
  #iceLocal = { host: 0, srflx: 0, relay: 0, other: 0 };
  #iceRemote: Array<{ transport: string; port: number }> = [];
  #iceTransitions: RelayCallIceDiagnostics["transitions"] = [];
  readonly #listeners = new Map<TransportEvent, Set<(...args: any[]) => void>>();
  #factory: RelayWebRTCFactory | undefined;
  #peer: RelayPeerConnectionLike | undefined;
  /** Bumped for every peer built; work started for an older peer stops when it sees a newer one. */
  #peerGeneration = 0;
  /** The current peer has reached `connected` since it was built. */
  #peerConnected = false;
  #audioSource: RelayAudioSourceLike | undefined;
  #localTrack: RelayMediaStreamTrackLike | undefined;
  #remoteSink: RelayAudioSinkLike | undefined;
  #publishTransceiver: RelayRtpTransceiverLike | undefined;
  #publishFrame: CallRoomPublishOfferFrame | undefined;
  #initialAnswerSdp: string | undefined;
  #negotiationTail: Promise<void> = Promise.resolve();
  #restarts = 0;
  /** Restarts since the last `connected`; sets the backoff. */
  #failedAttempts = 0;
  #restartPending = false;
  #wakeRestart: (() => void) | undefined;
  #connectTimer: NodeJS.Timeout | undefined;
  #disconnectTimer: NodeJS.Timeout | undefined;
  #callStatus: CallStatus | undefined;
  #remoteVideo = false;
  #personConnected = false;
  #peerAudioArrived = false;
  #peerAudioReady = false;
  readonly #peerAudioWaiters = new Set<{ resolve: () => void; reject: (error: Error) => void }>();
  #ended = false;
  #audioGeneration = 0;
  /** `waitForPlayout()` callers released early by `clearAudio()` or `close()`. */
  readonly #playoutWaiters = new Set<() => void>();
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
    const inbound = options.inboundAudio ?? DEFAULT_INBOUND_AUDIO;
    if (!INBOUND_SAMPLE_RATES.has(inbound.sampleRate)) {
      throw new Error("inboundAudio.sampleRate must be 8000, 12000, 16000, 24000 or 48000.");
    }
    if (inbound.channelCount !== 1 && inbound.channelCount !== 2) {
      throw new Error("inboundAudio.channelCount must be 1 or 2.");
    }
    const isDefaultInbound = inbound.sampleRate === DEFAULT_INBOUND_AUDIO.sampleRate
      && inbound.channelCount === DEFAULT_INBOUND_AUDIO.channelCount;
    if (!options.webRTC && this.#engine === "wrtc" && !isDefaultInbound) {
      // `@roamhq/wrtc`'s nonstandard RTCAudioSink hands over libwebrtc's own
      // PCM and takes no format; honouring another one would mean resampling here.
      throw new Error('The "wrtc" engine cannot decode to inboundAudio; use the "werift" engine.');
    }
    this.#inboundAudio = { sampleRate: inbound.sampleRate, channelCount: inbound.channelCount };
    this.#iceGatheringTimeoutMs = options.iceGatheringTimeoutMs ?? DEFAULT_ICE_GATHERING_TIMEOUT_MS;
    this.#sessionConnectTimeoutMs = options.sessionConnectTimeoutMs
      ?? options.mediaConnectTimeoutMs
      ?? options.connectionTimeoutMs
      ?? RESTART_CONNECT_TIMEOUT_MS;
    const policy = options.iceTransportPolicy ?? "all";
    if (policy !== "all" && policy !== "relay") {
      throw new Error('iceTransportPolicy must be "all" or "relay".');
    }
    this.#iceTransportPolicy = policy;
    const iceServers = options.iceServers ?? [];
    this.#iceServers = typeof iceServers === "function" ? iceServers : copyIceServers(iceServers);
    if (!Number.isFinite(this.#iceGatheringTimeoutMs) || this.#iceGatheringTimeoutMs <= 0) {
      throw new Error("iceGatheringTimeoutMs must be greater than zero.");
    }
    if (!Number.isFinite(this.#sessionConnectTimeoutMs) || this.#sessionConnectTimeoutMs <= 0) {
      throw new Error("sessionConnectTimeoutMs must be greater than zero.");
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

  /**
   * Join the room, publish, and resolve on the first `connected`. Dead SFU
   * sessions are replaced as they are found (PROTOCOL.md section 4), with no
   * overall deadline: this rejects only when the Call ends, the room or
   * transport closes, the room reports an error, or `signal` aborts (which
   * also closes the transport).
   */
  async connect(options: { signal?: AbortSignal } = {}): Promise<void> {
    if (this.#closed) throw new Error("Relay Call transport is closed.");
    const { signal } = options;
    const aborted = (): RelayCallTransportError =>
      new RelayCallTransportError("Relay Call connect was aborted.", "aborted");
    if (signal?.aborted) throw aborted();
    const abort = (): void => {
      this.#rejectReady(aborted());
      this.close();
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      await this.#connect();
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  async #connect(): Promise<void> {
    this.#attachRoomHandlers();
    await this.#room.connect();
    if (this.#factory) {
      await this.#ready;
      return;
    }
    this.#factory = this.#providedFactory ?? await loadWebRTCFactory(this.#engine);
    this.#audioSource = this.#factory.createAudioSource();
    this.#localTrack = this.#audioSource.createTrack();
    if (this.#localTrack.kind !== "audio") {
      throw new RelayCallTransportError("The WebRTC binding created a non-audio Relay track.");
    }
    this.#connectStartedAt = Date.now();
    try {
      await this.#startPeer();
      await this.#ready;
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
   * ICE candidates, state transitions, packet counts in both directions,
   * room frame counts and restarts recorded for this call, with a one-line summary.
   */
  diagnostics(): RelayCallIceDiagnostics {
    const snapshot = {
      local: { ...this.#iceLocal },
      remote: this.#iceRemote.map((candidate) => ({ ...candidate })),
      transitions: this.#iceTransitions.map((transition) => ({ ...transition })),
      connected: this.#peerConnected,
      inbound: this.#inboundDiagnostics(),
      outbound: this.#outboundDiagnostics(),
      room: {
        roomStates: this.#roomStates,
        offers: this.#roomOffers,
        endedReason: this.#endedReason,
        errors: [...this.#roomErrors],
      },
      restarts: this.#restarts,
    };
    return { ...snapshot, summary: summarize(snapshot) };
  }

  #sinceConnect(epochMs: number | undefined): number | undefined {
    return epochMs === undefined ? undefined : epochMs - this.#connectStartedAt;
  }

  /** The live sink's counts added to those of sinks retired by restarts. */
  #sinkStats(): RelayAudioSinkStats | undefined {
    const current = this.#remoteSink?.stats?.();
    const retired = this.#retiredSinkStats;
    if (!retired) return current;
    if (!current) return { ...retired, recentRtpPackets: 0 };
    return {
      rtpPackets: retired.rtpPackets + current.rtpPackets,
      decodeFailures: retired.decodeFailures + current.decodeFailures,
      firstRtpAt: retired.firstRtpAt ?? current.firstRtpAt,
      lastRtpAt: current.lastRtpAt ?? retired.lastRtpAt,
      recentRtpPackets: current.recentRtpPackets,
    };
  }

  #inboundDiagnostics(): RelayCallInboundDiagnostics {
    const stats = this.#finalSinkStats ?? this.#sinkStats();
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
      silencePackets: stats?.silencePackets ?? 0,
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
   * source slices and handed to the engine at once; the engine's 20 ms pump
   * paces the wire, so adapters may push faster than real time (LiveKit's
   * `AudioSource.captureFrame` shape). Resolves once the slices are queued;
   * `waitForPlayout()` tells when they have left.
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
    this.#writeAudio(captured, this.#audioGeneration);
    return Promise.resolve();
  }

  /** Milliseconds of audio accepted by `writeAudio` but not yet written to RTP. */
  queuedAudioMs(): number {
    return this.#audioSource?.queuedMs?.() ?? 0;
  }

  /**
   * Resolves when every accepted slice has been written to RTP and the engine's
   * pump is idle; immediately when nothing is queued; early on `clearAudio()`
   * or `close()` (the caller reads `queuedAudioMs()` to learn what was dropped).
   */
  waitForPlayout(): Promise<void> {
    const source = this.#audioSource;
    if (!source || this.#closed || this.queuedAudioMs() === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const release = (): void => {
        this.#playoutWaiters.delete(release);
        resolve();
      };
      this.#playoutWaiters.add(release);
      const drained = source.waitForDrain?.() ?? Promise.resolve();
      drained.then(release, release);
    });
  }

  /** Drop outgoing PCM that has not reached RTP and release `waitForPlayout()` callers. */
  clearAudio(): void {
    this.#audioGeneration += 1;
    this.#audioSource?.clear?.();
    this.#releasePlayoutWaiters();
  }

  /**
   * Resolves once `peerAudio` has fired (at once if it already has). Rejects
   * after `timeoutMs`, or when the Call ends or the transport closes first.
   */
  waitForPeerAudio(timeoutMs: number): Promise<void> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return Promise.reject(new Error("waitForPeerAudio timeoutMs must be greater than zero."));
    }
    if (this.#peerAudioReady) return Promise.resolve();
    if (this.#closed || this.#ended) {
      return Promise.reject(new RelayCallTransportError("Relay Call ended before the person's audio arrived."));
    }
    return new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve: () => { clearTimeout(timer); this.#peerAudioWaiters.delete(waiter); resolve(); },
        reject: (error: Error) => { clearTimeout(timer); this.#peerAudioWaiters.delete(waiter); reject(error); },
      };
      const timer = setTimeout(() => waiter.reject(new RelayCallTransportError(
        `Timed out waiting for the person's audio (${this.diagnostics().summary})`,
      )), timeoutMs);
      timer.unref?.();
      this.#peerAudioWaiters.add(waiter);
    });
  }

  #checkPeerAudio(): void {
    if (this.#peerAudioReady || !this.#peerAudioArrived || !this.#personConnected) return;
    this.#peerAudioReady = true;
    for (const waiter of [...this.#peerAudioWaiters]) waiter.resolve();
    this.#emit("peerAudio");
  }

  #rejectPeerAudio(error: Error): void {
    for (const waiter of [...this.#peerAudioWaiters]) waiter.reject(error);
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
    this.#rejectPeerAudio(new RelayCallTransportError("Relay Call transport closed before the person's audio arrived."));
    this.#audioGeneration += 1;
    this.#shutdownMedia();
    this.#releasePlayoutWaiters();
    this.#room.close();
  }

  /**
   * Build a peer connection around the one local track and publish it. The
   * first peer sends a plain `offer`; every later one is a restart onto a new
   * SFU session (`restart: true`) with ICE servers fetched again.
   */
  async #startPeer(): Promise<void> {
    const factory = this.#factory;
    const track = this.#localTrack;
    if (!factory || !track) throw new Error("Relay Call transport is not connected.");
    const restarts = this.#restarts;
    const generation = ++this.#peerGeneration;
    const iceServers = typeof this.#iceServers === "function"
      ? copyIceServers(await this.#iceServers({ restarts }))
      : copyIceServers(this.#iceServers);
    if (this.#closed || this.#ended || generation !== this.#peerGeneration) return;
    const peer = factory.createPeerConnection({ iceServers, iceTransportPolicy: this.#iceTransportPolicy });
    this.#peer = peer;
    this.#peerConnected = false;
    this.#initialAnswerSdp = undefined;
    this.#publishTransceiver = peer.addTransceiver(track, { direction: "sendonly" });
    this.#observeIce(peer);
    peer.onconnectionstatechange = () => {
      if (this.#peer !== peer) return;
      this.#recordTransition("connection", peer.connectionState);
      this.#connectionStateChanged(peer);
    };
    peer.ontrack = (event) => {
      if (this.#peer === peer) this.#remoteTrack(event.track);
    };
    await this.#publishLocalAudio(peer, restarts > 0);
  }

  async #publishLocalAudio(peer: RelayPeerConnectionLike, restart: boolean): Promise<void> {
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    await this.#waitForIceGathering(peer);
    if (this.#peer !== peer) return;
    const description = this.#localDescription(peer, "offer");
    const mid = this.#publishTransceiver?.mid;
    if (!mid) throw new RelayCallTransportError("Relay audio publication has no WebRTC MID.");
    this.#publishFrame = {
      type: "offer",
      session_description: description,
      tracks: [{ mid, name: "audio" }],
      ...(restart ? { restart: true } : {}),
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
      this.#callStatus = frame.call?.status;
      // A Call has exactly one agent; the transport is that agent, so the
      // person is the other participant.
      const person = frame.participants?.find((participant) => participant.kind === "user");
      const video = person?.video === true;
      const videoChanged = video !== this.#remoteVideo;
      this.#remoteVideo = video;
      this.#personConnected = person?.connected === true;
      this.#emit("roomState", frame);
      if (videoChanged) this.#emit("remoteVideo", video);
      this.#checkPeerAudio();
    });
    this.#room.on("error", (error: CallRoomErrorFrame | Error) => {
      if (error instanceof Error) {
        this.#rejectReady(error);
        this.#emit("error", error);
      } else this.#serverError(error);
    });
    this.#room.on("ended", (frame: CallRoomEndedFrame) => {
      this.#ended = true;
      this.#endedReason = frame.reason;
      this.#rejectReady(new RelayCallTransportError(`Relay Call ended before media connected (${frame.reason}).`));
      this.#rejectPeerAudio(new RelayCallTransportError(
        `Relay Call ended before the person's audio arrived (${frame.reason}).`,
      ));
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
    // No peer: the answer is for a session a restart already replaced.
    const peer = this.#peer;
    if (!peer) return;
    const sdp = frame.session_description.sdp;
    // Reconnecting the signaling socket replays the exact initial offer. Relay
    // returns its cached answer; applying that answer again in stable state is
    // invalid WebRTC signaling, so recognize and ignore the replay.
    if (peer.signalingState === "stable" && this.#initialAnswerSdp === sdp) return;
    const initial = this.#initialAnswerSdp === undefined;
    if (initial) this.#recordRemoteCandidates(sdp);
    await peer.setRemoteDescription(frame.session_description);
    if (this.#peer !== peer) return;
    this.#initialAnswerSdp ??= sdp;
    if (initial && !this.#peerConnected) this.#armConnectTimer(peer);
  }

  async #serverOffer(frame: CallRoomSubscriptionOfferFrame): Promise<void> {
    const peer = this.#peer;
    // A pull offer that arrives while this participant's restart offer is
    // unanswered was sent for the replaced session: the room clears those
    // pulls on restart and pulls again after the new session connects.
    if (!peer || peer.signalingState === "have-local-offer") return;
    // `video` m-lines are answered receive-only by the engine and never decoded
    // (`#remoteTrack` takes audio only).
    await peer.setRemoteDescription(frame.session_description);
    const answer = await peer.createAnswer();
    await peer.setLocalDescription(answer);
    await this.#waitForIceGathering(peer);
    if (this.#peer !== peer) return;
    this.#room.send({ type: "answer", session_description: this.#localDescription(peer, "answer") });
  }

  #serverError(frame: CallRoomErrorFrame): void {
    this.#roomErrors.push(frame.message);
    const error = new RelayCallTransportError(frame.message, frame.code);
    this.#rejectReady(error);
    this.#emit("error", error);
  }

  #connectionStateChanged(peer: RelayPeerConnectionLike): void {
    const state = peer.connectionState;
    if (state === "connected") {
      this.#clearTimer("connect");
      this.#clearTimer("disconnect");
      if (this.#peerConnected) return;
      this.#peerConnected = true;
      this.#failedAttempts = 0;
      // The SFU will not pull a track that has carried no RTP, so the source
      // sends silence from here on until it is closed.
      this.#audioSource?.start?.();
      try {
        // Sent for every new session: the room re-pulls a restarted participant's
        // tracks once it reports `connected` (PROTOCOL.md section 2).
        this.#room.connected();
        if (!this.#reportedConnected) {
          this.#reportedConnected = true;
          this.#resolveReady();
          this.#startStallGuard();
          this.#emit("connected");
        }
      } catch (error) {
        const parsed = error instanceof Error ? error : new Error(String(error));
        this.#rejectReady(parsed);
        this.#emit("error", parsed);
      }
    } else if (state === "failed") {
      this.#requestRestart("failed", peer);
    } else if (state === "disconnected") {
      if (this.#disconnectTimer) return;
      this.#disconnectTimer = setTimeout(() => {
        this.#disconnectTimer = undefined;
        if (peer.connectionState !== "connected") this.#requestRestart("disconnected", peer);
      }, RESTART_DISCONNECTED_MS);
      this.#disconnectTimer.unref?.();
    }
  }

  #armConnectTimer(peer: RelayPeerConnectionLike): void {
    this.#clearTimer("connect");
    this.#connectTimer = setTimeout(() => {
      this.#connectTimer = undefined;
      if (!this.#peerConnected) this.#requestRestart("timeout", peer);
    }, this.#sessionConnectTimeoutMs);
    this.#connectTimer.unref?.();
  }

  #clearTimer(which: "connect" | "disconnect"): void {
    if (which === "connect") {
      clearTimeout(this.#connectTimer);
      this.#connectTimer = undefined;
    } else {
      clearTimeout(this.#disconnectTimer);
      this.#disconnectTimer = undefined;
    }
  }

  #callActive(): boolean {
    if (this.#closed || this.#ended) return false;
    return this.#callStatus === undefined || ACTIVE_CALL_STATUSES.has(this.#callStatus);
  }

  /**
   * Retire `peer` now, wait the backoff, then publish from a new peer on a new
   * session. Unlimited while the Call is ringing or in progress; stops on
   * `ended`, a terminal status, or `close()`.
   */
  #requestRestart(reason: RelayCallRestartReason, peer: RelayPeerConnectionLike | undefined): void {
    if (this.#restartPending || peer !== this.#peer || !this.#callActive()) return;
    const summary = this.diagnostics().summary;
    this.#restartPending = true;
    this.#restarts += 1;
    this.#failedAttempts += 1;
    const restarts = this.#restarts;
    const delayMs = restartDelayMs(this.#failedAttempts);
    this.#retirePeer();
    this.#queueNegotiation(async () => {
      await this.#restartBackoff(delayMs);
      this.#restartPending = false;
      if (!this.#callActive()) return;
      try {
        await this.#startPeer();
      } catch (error) {
        if (!this.#callActive()) return;
        const parsed = error instanceof Error ? error : new Error(String(error));
        this.#emit("error", new RelayCallTransportError(
          `Relay WebRTC restart ${restarts} failed: ${parsed.message}`,
          "restart_failed",
        ));
        this.#requestRestart("error", this.#peer);
        return;
      }
      if (this.#peer) this.#emit("restarted", { reason, summary, restarts, delayMs });
    });
  }

  #restartBackoff(milliseconds: number): Promise<void> {
    return new Promise((resolve) => {
      const wake = (): void => {
        clearTimeout(timer);
        if (this.#wakeRestart === wake) this.#wakeRestart = undefined;
        resolve();
      };
      const timer = setTimeout(wake, milliseconds);
      timer.unref?.();
      this.#wakeRestart = wake;
    });
  }

  /** Close the current peer and its sink; the audio source and local track stay for the next peer. */
  #retirePeer(): void {
    this.#clearTimer("connect");
    this.#clearTimer("disconnect");
    const peer = this.#peer;
    this.#peer = undefined;
    this.#peerConnected = false;
    this.#publishTransceiver = undefined;
    this.#initialAnswerSdp = undefined;
    if (this.#remoteSink) {
      this.#retiredSinkStats = this.#sinkStats();
      this.#remoteSink.stop();
      this.#remoteSink = undefined;
    }
    if (!peer) return;
    peer.onconnectionstatechange = null;
    peer.ontrack = null;
    peer.onicecandidate = null;
    peer.onicegatheringstatechange = null;
    peer.oniceconnectionstatechange = null;
    closePeer(peer);
  }

  #remoteTrack(track: RelayMediaStreamTrackLike): void {
    if (track.kind !== "audio" || !this.#factory) return;
    this.#remoteSink?.stop();
    const sink = this.#factory.createAudioSink(track, this.#inboundAudio);
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
      if (!this.#peerAudioArrived) {
        this.#peerAudioArrived = true;
        this.#checkPeerAudio();
      }
    };
  }

  #writeAudio(frame: RelayAudioFrame, generation: number): void {
    const source = this.#audioSource;
    if (!source || generation !== this.#audioGeneration) return;
    const samplesPerChannel = (frame.sampleRate * AUDIO_SLICE_MS) / 1000;
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
    }
  }

  #releasePlayoutWaiters(): void {
    for (const release of [...this.#playoutWaiters]) release();
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

  #localDescription<T extends "offer" | "answer">(
    peer: RelayPeerConnectionLike,
    type: T,
  ): { type: T; sdp: string } {
    const local = peer.localDescription;
    if (!local || local.type !== type || !local.sdp) {
      throw new RelayCallTransportError(`Relay WebRTC did not produce a complete ${type} SDP.`);
    }
    return { type, sdp: local.sdp };
  }

  #shutdownMedia(): void {
    this.#stopStallGuard();
    this.#clearTimer("connect");
    this.#clearTimer("disconnect");
    this.#wakeRestart?.();
    this.#finalSinkStats ??= this.#sinkStats();
    this.#finalSourceStats ??= this.#audioSource?.stats?.();
    this.#remoteSink?.stop();
    this.#remoteSink = undefined;
    this.#localTrack?.stop();
    this.#localTrack = undefined;
    if (this.#peer) closePeer(this.#peer);
    this.#peer = undefined;
    this.#audioSource = undefined;
  }

  #emit<K extends TransportEvent>(event: K, ...args: TransportEventMap[K]): void {
    for (const listener of this.#listeners.get(event) ?? []) {
      try { listener(...args); } catch { /* adapters own listener failures */ }
    }
  }
}
