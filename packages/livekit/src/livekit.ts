import { AudioInput, AudioOutput, Future, type AgentSession } from "@livekit/agents";
import { AudioFrame, type VideoFrame as RtcVideoFrame, type VideoFrameEvent } from "@livekit/rtc-node";
import {
  TransformStream,
  type ReadableStreamDefaultReader,
  type WritableStreamDefaultWriter,
} from "node:stream/web";
import type Relay from "@relaymessenger/sdk";
import type { CallRoom, CallRoomOptions } from "@relaymessenger/sdk";
import {
  RelayCallTransport,
  type RelayAudioFrame,
  type RelayCallIceDiagnostics,
  type RelayCallTransportOptions,
  type RelayIceServer,
  type RelayIceServersProvider,
  type RelayInboundAudioFormat,
  type RelayIceTransportPolicy,
  type RelayWebRTCFactory,
  type RemoteVideoTrack,
} from "@relaymessenger/sdk/calls";
import { VideoStream } from "./video.js";

/**
 * The format LiveKit's own room input hands an AgentSession:
 * `@livekit/agents` dist/voice/room_io/room_io.js:46-48
 * `DEFAULT_ROOM_INPUT_OPTIONS = { audioSampleRate: 24e3, audioNumChannels: 1 }`,
 * passed to the participant `AudioStream` (room_io.js:373-374). Plugins
 * resample assuming the channel count they construct with
 * (`@livekit/agents-plugin-google` 1.9.0 realtime_api.js:1307-1329
 * `new AudioResampler(frame.sampleRate, 16000, 1)`; rtc-node's resampler reads
 * raw bytes and ignores `frame.channels`), so the session must receive mono.
 */
export const LIVEKIT_ROOM_INPUT_AUDIO: Readonly<RelayInboundAudioFormat> = Object.freeze({
  sampleRate: 24_000,
  channelCount: 1,
});

/** LiveKit Agents input backed by the remote Relay participant's WebRTC audio. */
export class RelayAudioInput extends AudioInput {
  readonly #transport: RelayCallTransport;
  readonly #writer: WritableStreamDefaultWriter<AudioFrame>;
  readonly #onAudio: (frame: RelayAudioFrame) => void;
  /** Serial write chain: each frame waits for the writer, as `pipeTo` does in LiveKit's input. */
  #writes: Promise<void> = Promise.resolve();
  #attached = false;
  #closed = false;

  constructor(transport: RelayCallTransport) {
    super();
    this.#transport = transport;
    const channel = new TransformStream<AudioFrame, AudioFrame>();
    this.#writer = channel.writable.getWriter();
    this.multiStream.addInputStream(channel.readable);
    this.#onAudio = (frame) => {
      if (this.#closed || !this.#attached) return;
      const audio = new AudioFrame(
        frame.samples,
        frame.sampleRate,
        frame.channelCount,
        frame.samples.length / frame.channelCount,
      );
      // LiveKit's ParticipantAudioInputStream pipes its AudioStream into the
      // session with `pipeTo(output.writable)` (room_io/_input.js:161-162),
      // which awaits the writer before each chunk. The transport pushes and
      // cannot be paused, so the frames wait here in order instead.
      this.#writes = this.#writes
        .then(async () => {
          await this.#writer.ready;
          await this.#writer.write(audio);
        })
        .catch(() => undefined);
    };
    this.#transport.on("audio", this.#onAudio);
  }

  override setAttached(attached: boolean): void {
    this.#attached = attached;
  }

  override async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#transport.off("audio", this.#onAudio);
    await this.#writes;
    await this.#writer.close().catch(() => undefined);
    await super.close();
  }
}

/**
 * The remote Relay participant's camera as `@livekit/rtc-node` `VideoFrame`s
 * (I420).
 *
 * Twin of the Python package's `RelayVideoInput` (LiveKit's
 * `_ParticipantVideoInputStream`). LiveKit Agents for Node has no
 * `session.input.video`, so the frames are read here: iterate them into a
 * realtime model's `pushVideo`, or put `latestFrame` into an
 * `llm.ImageContent` when the user's turn completes, as LiveKit's Node
 * vision guide does with a room `VideoStream`. The input follows the
 * transport's one `RemoteVideoTrack`, which survives media restarts. A reader
 * gets the newest frame, never a backlog: a frame not yet read is replaced by
 * a newer one, as a live camera does.
 */
export class RelayVideoInput implements AsyncIterable<RtcVideoFrame> {
  readonly #transport: RelayCallTransport;
  readonly #onTrack: (track: RemoteVideoTrack) => void;
  #reader: ReadableStreamDefaultReader<VideoFrameEvent> | undefined;
  #reading: Promise<void> | undefined;
  #latest: RtcVideoFrame | undefined;
  #pending: RtcVideoFrame | undefined;
  readonly #waiters = new Set<() => void>();
  #attached = true;
  #started = false;
  #closed = false;

  /** Nothing is decoded until the first read, so an audio-only agent never decodes the camera. */
  constructor(transport: RelayCallTransport) {
    this.#transport = transport;
    this.#onTrack = (track) => this.#subscribe(track);
  }

  /**
   * The most recent frame from the person's camera, or `undefined` before the
   * first one. The first read starts decoding.
   */
  get latestFrame(): RtcVideoFrame | undefined {
    this.#start();
    return this.#latest;
  }

  /** While detached, frames are dropped, as LiveKit's input drops them. */
  setAttached(attached: boolean): void {
    this.#attached = attached;
  }

  /** Frames until the call's video ends or `close()`; starting it starts decoding. */
  async *[Symbol.asyncIterator](): AsyncIterator<RtcVideoFrame> {
    this.#start();
    for (;;) {
      const frame = this.#pending;
      if (frame) {
        this.#pending = undefined;
        yield frame;
        continue;
      }
      if (this.#closed) return;
      await new Promise<void>((resolve) => this.#waiters.add(resolve));
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#pending = undefined;
    this.#transport.off("trackSubscribed", this.#onTrack);
    this.#wake();
    await this.#reader?.cancel().catch(() => undefined);
    await this.#reading;
  }

  #start(): void {
    if (this.#started || this.#closed) return;
    this.#started = true;
    this.#transport.on("trackSubscribed", this.#onTrack);
    const existing = this.#transport.remoteVideoTrack;
    if (existing) this.#subscribe(existing);
  }

  #subscribe(track: RemoteVideoTrack): void {
    if (this.#closed || this.#reader) return;
    const reader = new VideoStream(track).getReader();
    this.#reader = reader;
    this.#reading = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || this.#closed) break;
        if (!this.#attached) continue;
        this.#latest = value.frame;
        this.#pending = value.frame;
        this.#wake();
      }
    })().catch(() => undefined).finally(() => {
      // The track ends only when the call does (restarts keep it), so a
      // reader that never calls close() still gets its loop back.
      if (this.#closed) return;
      this.#closed = true;
      this.#transport.off("trackSubscribed", this.#onTrack);
      this.#wake();
    });
  }

  #wake(): void {
    const waiters = [...this.#waiters];
    this.#waiters.clear();
    for (const resolve of waiters) resolve();
  }
}

/**
 * LiveKit Agents output that publishes TTS PCM to the Relay participant.
 *
 * Shape copied from `@livekit/agents` `ParticipantAudioOutput`
 * (dist/voice/room_io/_output.js): `captureFrame` hands the frame to the
 * transport and returns without waiting for playout, `flush()` starts a playout
 * task that reports `onPlaybackFinished` only once the transport has drained,
 * and `clearBuffer()` resolves the interruption future so that task reports
 * `interrupted: true` with the position actually played.
 */
export class RelayAudioOutput extends AudioOutput {
  readonly #transport: RelayCallTransport;
  /** Seconds pushed to the transport in the open segment. */
  #pushedDuration = 0;
  #firstFrameEmitted = false;
  #flushTask: Promise<void> | undefined;
  #flushDone = true;
  /** Resolved by `clearBuffer()` with the milliseconds still queued at that moment. */
  #interruptedFuture = new Future<number>();
  /** Bumped by `clearBuffer()`; a frame the transport dropped across it is not counted (agents-js `interruptionGeneration`). */
  #interruptionGeneration = 0;
  #closed = false;
  /**
   * Where the open segment's first sample sits on the agent's audio track
   * (what `writeAudio` resolved with), for timing Rive messages.
   */
  segmentStartMs: number | undefined;

  constructor(transport: RelayCallTransport, sampleRate = 48_000) {
    super(sampleRate, undefined, { pause: false });
    this.#transport = transport;
  }

  /**
   * Hands the frame to the transport, which holds it until the person receives
   * the agent's audio (PROTOCOL.md section 6b) and resolves once it is queued,
   * so this waits as LiveKit's room audio output waits for the track's
   * subscription. A frame dropped by `clearBuffer()` meanwhile is not counted.
   */
  override async captureFrame(frame: AudioFrame): Promise<void> {
    if (this.#closed) throw new Error("Relay LiveKit audio output is closed.");
    if (this.#flushTask && !this.#flushDone) {
      this.logger.error("captureFrame called while flush is in progress");
      await this.#flushTask;
    }
    const interruptionGeneration = this.#interruptionGeneration;
    // Resolves once the slices are queued, with where they start on the track; the engine's pump paces the wire.
    const startMs = await this.#transport.writeAudio({
      samples: frame.data,
      sampleRate: frame.sampleRate,
      channelCount: frame.channels,
    });
    if (interruptionGeneration !== this.#interruptionGeneration) return;
    await super.captureFrame(frame);
    if (!this.#firstFrameEmitted) {
      this.#firstFrameEmitted = true;
      this.segmentStartMs = typeof startMs === "number" ? startMs : undefined;
      this.onPlaybackStarted(Date.now());
    }
    this.#pushedDuration += frame.samplesPerChannel / frame.sampleRate;
  }

  /** Mark the segment complete; `onPlaybackFinished` fires once the transport has drained. */
  override flush(): void {
    super.flush();
    if (!this.#pushedDuration) return;
    if (this.#flushTask && !this.#flushDone) return;
    this.#flushDone = false;
    this.#flushTask = this.#waitForPlayoutTask().finally(() => {
      this.#flushDone = true;
    });
    void this.#flushTask.catch(() => undefined);
  }

  override clearBuffer(): void {
    this.#interruptionGeneration += 1;
    const queuedMs = this.#transport.queuedAudioMs();
    this.#transport.clearAudio();
    if (this.#interruptedFuture.done) return;
    if (this.#pushedDuration === 0 && this.pendingPlayoutSegments === 0) return;
    if (!this.#flushTask || this.#flushDone) this.flush();
    if (!this.#interruptedFuture.done) this.#interruptedFuture.resolve(queuedMs);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.clearBuffer();
  }

  async #waitForPlayoutTask(): Promise<void> {
    const interruptedFuture = this.#interruptedFuture;
    await Promise.race([this.#transport.waitForPlayout(), interruptedFuture.await]);
    const interrupted = interruptedFuture.done;
    let playbackPosition = this.#pushedDuration;
    if (interrupted) {
      playbackPosition = Math.max(0, playbackPosition - interruptedFuture.result / 1_000);
    }
    this.#pushedDuration = 0;
    this.#firstFrameEmitted = false;
    if (this.#interruptedFuture === interruptedFuture) this.#interruptedFuture = new Future<number>();
    this.onPlaybackFinished({ playbackPosition, interrupted });
  }
}

export interface RelayLiveKitAudio {
  input: RelayAudioInput;
  output: RelayAudioOutput;
}

export interface RelayLiveKitAudioOptions {
  outputSampleRate?: number;
}

/** Build LiveKit Agents audio IO around an already-connected Relay transport. */
export const createRelayLiveKitAudio = (
  transport: RelayCallTransport,
  options: RelayLiveKitAudioOptions = {},
): RelayLiveKitAudio => ({
  input: new RelayAudioInput(transport),
  output: new RelayAudioOutput(transport, options.outputSampleRate),
});

export interface RelayLiveKitConnectOptions extends RelayLiveKitAudioOptions {
  relay: Relay;
  callId: string;
  room?: CallRoomOptions;
  /** @internal Supply an already-created Call room in tests. */
  roomClient?: CallRoom;
  /** @internal */
  webRTC?: RelayWebRTCFactory;
  /**
   * STUN and TURN servers for the agent's WebRTC peer. Defaults to the servers
   * the Call room sends (Cloudflare STUN plus TURN credentials Relay mints). A
   * function is called again before every restart, to mint fresh TURN credentials.
   */
  iceServers?: RelayIceServer[] | RelayIceServersProvider;
  /** `"relay"` forces TURN. Defaults to `"all"`. */
  iceTransportPolicy?: RelayIceTransportPolicy;
  /** @internal */
  iceGatheringTimeoutMs?: number;
  /**
   * How long one SFU session has to connect before the transport restarts onto
   * a new one. Defaults to 2 seconds. `connect()` has no overall deadline.
   */
  sessionConnectTimeoutMs?: number;
  /** @deprecated Use `sessionConnectTimeoutMs`; now the per-session wait, not a `connect()` deadline. */
  mediaConnectTimeoutMs?: number;
  /** @deprecated Use `sessionConnectTimeoutMs`. */
  connectionTimeoutMs?: number;
  /** Aborting stops `connect()` and closes the transport; the Call itself is not ended. */
  signal?: AbortSignal;
}

type AgentSessionAudioTarget = Pick<AgentSession, "input" | "output">;

/**
 * First-party bridge between a Relay Call and a LiveKit Agents AgentSession.
 * Developers work with Relay call IDs and LiveKit audio IO; media negotiation
 * stays inside the transport.
 */
export class RelayLiveKitCall {
  readonly transport: RelayCallTransport;
  readonly input: RelayAudioInput;
  readonly output: RelayAudioOutput;
  /** The person's camera; see {@link RelayVideoInput}. Send the agent's own video with `transport.publishTrack`. */
  readonly videoInput: RelayVideoInput;
  #session: AgentSessionAudioTarget | undefined;
  #closed = false;

  private constructor(transport: RelayCallTransport, audio: RelayLiveKitAudio) {
    this.transport = transport;
    this.input = audio.input;
    this.output = audio.output;
    this.videoInput = new RelayVideoInput(transport);
  }

  static async connect(options: RelayLiveKitConnectOptions): Promise<RelayLiveKitCall> {
    const transportOptions: RelayCallTransportOptions = {
      relay: options.relay,
      callId: options.callId,
      inboundAudio: LIVEKIT_ROOM_INPUT_AUDIO,
      ...(options.room ? { room: options.room } : {}),
      ...(options.roomClient ? { roomClient: options.roomClient } : {}),
      ...(options.webRTC ? { webRTC: options.webRTC } : {}),
      ...(options.iceServers ? { iceServers: options.iceServers } : {}),
      ...(options.iceTransportPolicy ? { iceTransportPolicy: options.iceTransportPolicy } : {}),
      ...(options.iceGatheringTimeoutMs === undefined
        ? {}
        : { iceGatheringTimeoutMs: options.iceGatheringTimeoutMs }),
      ...(options.sessionConnectTimeoutMs === undefined
        ? {}
        : { sessionConnectTimeoutMs: options.sessionConnectTimeoutMs }),
      ...(options.mediaConnectTimeoutMs === undefined
        ? {}
        : { mediaConnectTimeoutMs: options.mediaConnectTimeoutMs }),
      ...(options.connectionTimeoutMs === undefined
        ? {}
        : { connectionTimeoutMs: options.connectionTimeoutMs }),
    };
    const transport = new RelayCallTransport(transportOptions);
    await transport.connect(options.signal ? { signal: options.signal } : {});
    return new RelayLiveKitCall(transport, createRelayLiveKitAudio(transport, options));
  }

  attach(session: AgentSessionAudioTarget): void {
    if (this.#closed) throw new Error("Relay LiveKit Call is closed.");
    if (this.#session && this.#session !== session) this.detach();
    this.#session = session;
    session.input.audio = this.input;
    session.output.audio = this.output;
  }

  detach(): void {
    if (!this.#session) return;
    if (this.#session.input.audio === this.input) this.#session.input.audio = null;
    if (this.#session.output.audio === this.output) this.#session.output.audio = null;
    this.#session = undefined;
  }

  /**
   * Resolves once the person's audio has arrived and the room shows them
   * connected (the transport's `peerAudio`). Await it before starting the
   * AgentSession so the greeting is heard.
   */
  waitForPeerAudio(timeoutMs: number): Promise<void> {
    return this.transport.waitForPeerAudio(timeoutMs);
  }

  /** ICE candidates and state transitions for this call, with a one-line summary for logs. */
  diagnostics(): RelayCallIceDiagnostics {
    return this.transport.diagnostics();
  }

  setMuted(muted: boolean): void {
    this.transport.setMuted(muted);
  }

  end(): void {
    this.transport.end();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.detach();
    this.output.close();
    await this.input.close();
    await this.videoInput.close();
    this.transport.close();
  }
}
