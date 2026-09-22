import { AudioInput, AudioOutput, Future, type AgentSession } from "@livekit/agents";
import { AudioFrame } from "@livekit/rtc-node";
import { TransformStream, type WritableStreamDefaultWriter } from "node:stream/web";
import type Relay from "@relaymessenger/sdk";
import type { CallRoom, CallRoomOptions } from "@relaymessenger/sdk";
import {
  RelayCallTransport,
  type RelayAudioFrame,
  type RelayCallIceDiagnostics,
  type RelayCallTransportOptions,
  type RelayIceServer,
  type RelayIceTransportPolicy,
  type RelayWebRTCFactory,
} from "./transport.js";

/** LiveKit Agents input backed by the remote Relay participant's WebRTC audio. */
export class RelayAudioInput extends AudioInput {
  readonly #transport: RelayCallTransport;
  readonly #writer: WritableStreamDefaultWriter<AudioFrame>;
  readonly #onAudio: (frame: RelayAudioFrame) => void;
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
      void this.#writer.write(audio).catch(() => undefined);
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
    await this.#writer.close().catch(() => undefined);
    await super.close();
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
  #closed = false;

  constructor(transport: RelayCallTransport, sampleRate = 48_000) {
    super(sampleRate, undefined, { pause: false });
    this.#transport = transport;
  }

  override async captureFrame(frame: AudioFrame): Promise<void> {
    if (this.#closed) throw new Error("Relay LiveKit audio output is closed.");
    if (this.#flushTask && !this.#flushDone) {
      this.logger.error("captureFrame called while flush is in progress");
      await this.#flushTask;
    }
    await super.captureFrame(frame);
    if (!this.#firstFrameEmitted) {
      this.#firstFrameEmitted = true;
      this.onPlaybackStarted(Date.now());
    }
    this.#pushedDuration += frame.samplesPerChannel / frame.sampleRate;
    // Resolves once the slices are queued; the engine's pump paces the wire.
    await this.#transport.writeAudio({
      samples: frame.data,
      sampleRate: frame.sampleRate,
      channelCount: frame.channels,
    });
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
  /** STUN and TURN servers for the agent's WebRTC peer. Defaults to none. */
  iceServers?: RelayIceServer[];
  /** `"relay"` forces TURN. Defaults to `"all"`. */
  iceTransportPolicy?: RelayIceTransportPolicy;
  /** @internal */
  iceGatheringTimeoutMs?: number;
  /** Maximum wait for WebRTC media to connect. Defaults to 15 seconds. */
  mediaConnectTimeoutMs?: number;
  /** @deprecated Use `mediaConnectTimeoutMs`. */
  connectionTimeoutMs?: number;
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
  #session: AgentSessionAudioTarget | undefined;
  #closed = false;

  private constructor(transport: RelayCallTransport, audio: RelayLiveKitAudio) {
    this.transport = transport;
    this.input = audio.input;
    this.output = audio.output;
  }

  static async connect(options: RelayLiveKitConnectOptions): Promise<RelayLiveKitCall> {
    const transportOptions: RelayCallTransportOptions = {
      relay: options.relay,
      callId: options.callId,
      ...(options.room ? { room: options.room } : {}),
      ...(options.roomClient ? { roomClient: options.roomClient } : {}),
      ...(options.webRTC ? { webRTC: options.webRTC } : {}),
      ...(options.iceServers ? { iceServers: options.iceServers } : {}),
      ...(options.iceTransportPolicy ? { iceTransportPolicy: options.iceTransportPolicy } : {}),
      ...(options.iceGatheringTimeoutMs === undefined
        ? {}
        : { iceGatheringTimeoutMs: options.iceGatheringTimeoutMs }),
      ...(options.mediaConnectTimeoutMs === undefined
        ? {}
        : { mediaConnectTimeoutMs: options.mediaConnectTimeoutMs }),
      ...(options.connectionTimeoutMs === undefined
        ? {}
        : { connectionTimeoutMs: options.connectionTimeoutMs }),
    };
    const transport = new RelayCallTransport(transportOptions);
    await transport.connect();
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
    this.transport.close();
  }
}
