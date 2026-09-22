import { AudioInput, AudioOutput, type AgentSession } from "@livekit/agents";
import { AudioFrame } from "@livekit/rtc-node";
import { TransformStream, type WritableStreamDefaultWriter } from "node:stream/web";
import type Relay from "@relaymessenger/sdk";
import type { CallRoomOptions } from "@relaymessenger/sdk";
import {
  RelayCallTransport,
  type RelayAudioFrame,
  type RelayCallTransportOptions,
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

/** LiveKit Agents output that publishes TTS PCM to the Relay participant. */
export class RelayAudioOutput extends AudioOutput {
  readonly #transport: RelayCallTransport;
  #segmentDuration = 0;
  #segmentStarted = false;
  #segmentStartedAt = 0;
  #closed = false;

  constructor(transport: RelayCallTransport, sampleRate = 48_000) {
    super(sampleRate, undefined, { pause: false });
    this.#transport = transport;
  }

  override async captureFrame(frame: AudioFrame): Promise<void> {
    if (this.#closed) throw new Error("Relay LiveKit audio output is closed.");
    await super.captureFrame(frame);
    if (!this.#segmentStarted) {
      this.#segmentStarted = true;
      this.#segmentStartedAt = Date.now();
      this.onPlaybackStarted(this.#segmentStartedAt);
    }
    this.#segmentDuration += frame.samplesPerChannel / frame.sampleRate;
    await this.#transport.writeAudio({
      samples: frame.data,
      sampleRate: frame.sampleRate,
      channelCount: frame.channels,
    });
  }

  override flush(): void {
    super.flush();
    if (!this.#segmentStarted) return;
    this.onPlaybackFinished({
      playbackPosition: this.#segmentDuration,
      interrupted: false,
    });
    this.#resetSegment();
  }

  override clearBuffer(): void {
    this.#transport.clearAudio();
    if (!this.#segmentStarted) return;
    this.onPlaybackFinished({
      playbackPosition: Math.min(
        this.#segmentDuration,
        Math.max(0, (Date.now() - this.#segmentStartedAt) / 1_000),
      ),
      interrupted: true,
    });
    this.#resetSegment();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.clearBuffer();
  }

  #resetSegment(): void {
    this.#segmentDuration = 0;
    this.#segmentStarted = false;
    this.#segmentStartedAt = 0;
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
  /** @internal */
  webRTC?: RelayWebRTCFactory;
  /** @internal */
  iceGatheringTimeoutMs?: number;
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
      ...(options.webRTC ? { webRTC: options.webRTC } : {}),
      ...(options.iceGatheringTimeoutMs === undefined
        ? {}
        : { iceGatheringTimeoutMs: options.iceGatheringTimeoutMs }),
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
