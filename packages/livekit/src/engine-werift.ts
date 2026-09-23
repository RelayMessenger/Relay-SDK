/**
 * Relay's default call participant engine: werift (pure-TypeScript WebRTC:
 * ICE, DTLS, SRTP, RTP) plus `@evan/opus` (prebuilt libopus, WASM fallback).
 *
 * API sources read for this file, in node_modules/werift/lib/webrtc/src:
 * - peerConnection.d.ts: `new RTCPeerConnection({ codecs: { audio: [...] } })`,
 *   `addTransceiver(track, { direction })`, the W3C-style `ontrack`,
 *   `onconnectionstatechange`, `localDescription`, `close()`, and the
 *   `"icegatheringstatechange"` / `"connectionstatechange"` events emitted
 *   through `EventTarget.addEventListener` (peerConnection.js:317, :330).
 *   `RTCConfiguration.iceServers: RTCIceServer[]` ({ urls, username?,
 *   credential? }) and `iceTransportPolicy: "all" | "relay"` (peerConnection.d.ts
 *   :264-273); utils.js:110-179 parses `stun|stuns|turn|turns:` URLs with
 *   `?transport=`, and `secureTransportManager.js:121` maps `"relay"` to
 *   `forceTurn`. The W3C setters `onicecandidate`, `onicegatheringstatechange`
 *   and `oniceconnectionstatechange` (peerConnection.d.ts:67-82, fired at
 *   peerConnection.js:314-341) feed the transport's ICE diagnostics.
 * - media/track.d.ts: `MediaStreamTrack({ kind })`, `writeRtp(RtpPacket)`,
 *   `onReceiveRtp: Event<[RtpPacket, Extensions?]>` with `subscribe()`.
 * - media/rtpSender.js:544-549: the sender rewrites ssrc and payloadType and
 *   offsets sequenceNumber/timestamp, so the local track starts both at 0.
 * - ../../rtp/src/codec/opus.d.ts: `OpusRtpPayload.deSerialize(buffer)`.
 * - node_modules/@evan/opus/lib.d.ts: `Encoder.encode(pcm16)` returns one Opus
 *   packet; `Decoder.decode(packet)` returns interleaved PCM16 bytes;
 *   `new Decoder({ channels?: 1 | 2, sample_rate?: 8000 | 12000 | 16000 |
 *   24000 | 48000 })` decodes any Opus stream to that count and rate (libopus
 *   `opus_decoder_create(Fs, channels)`), which is how the sink honours
 *   `RelayInboundAudioFormat`.
 * Participant shapes copied from the headless phone that joined Relay's room
 * through Cloudflare's SFU on 2026-09-21 (_runtime/bin/headless-phone-webrtc.mjs
 * lines 93-160): `bundlePolicy: "max-bundle", iceServers: []` (Cloudflare
 * supplies its ICE candidates in the answer), the local track is id
 * "microphone" in stream "relay-call" (Relay-iOS RelayWebRTCAudioTransport),
 * the first RTP packet carries the marker bit, empty payloads are skipped and a
 * decode failure never tears the sink down.
 */
import { Decoder, Encoder } from "@evan/opus";
import {
  MediaStreamTrack,
  OpusRtpPayload,
  RTCPeerConnection,
  RTCRtpCodecParameters,
  RtpHeader,
  RtpPacket,
} from "werift";
import type {
  RelayAudioSinkLike,
  RelayAudioSinkStats,
  RelayAudioSourceLike,
  RelayAudioSourceStats,
  RelayInboundAudioFormat,
  RelayMediaStreamTrackLike,
  RelayPeerConnectionConfig,
  RelayPeerConnectionLike,
  RelayWebRTCFactory,
} from "./transport.js";

/** Opus on the wire is always 48 kHz; Relay sends stereo so callers may pass either channel count. */
export const WERIFT_SAMPLE_RATE = 48_000;
export const WERIFT_CHANNEL_COUNT = 2;
/** One RTP packet carries 20 ms: 960 frames at 48 kHz, timestamp advances by 960. */
export const WERIFT_PACKET_MS = 20;
const PACKET_FRAMES = (WERIFT_SAMPLE_RATE * WERIFT_PACKET_MS) / 1000;
const PACKET_SAMPLES = PACKET_FRAMES * WERIFT_CHANNEL_COUNT;
/** Dynamic payload type; werift's sender replaces it with the negotiated one. */
const LOCAL_PAYLOAD_TYPE = 111;

export type WeriftAudioSourceData = Parameters<RelayAudioSourceLike["onData"]>[0];

/** Packets counted for `diagnostics()`; the recent window is the last 5 s. */
export const STATS_WINDOW_MS = 5_000;

/** Monotone packet counter with first/last epoch timestamps and a 5 s window. */
class PacketClock {
  count = 0;
  firstAt: number | undefined;
  lastAt: number | undefined;
  readonly #recent: number[] = [];

  mark(now = Date.now()): void {
    this.count += 1;
    this.firstAt ??= now;
    this.lastAt = now;
    this.#recent.push(now);
    this.#prune(now);
  }

  recent(now = Date.now()): number {
    this.#prune(now);
    return this.#recent.length;
  }

  #prune(now: number): void {
    const floor = now - STATS_WINDOW_MS;
    let drop = 0;
    while (drop < this.#recent.length && this.#recent[drop]! < floor) drop += 1;
    if (drop) this.#recent.splice(0, drop);
  }
}

/**
 * A pacer more than this far behind its clock re-anchors instead of bursting
 * the backlog. LiveKit's native `AudioSource` (rust-sdks
 * webrtc-sys/src/audio_track.cpp:161-188) runs a 10 ms libwebrtc
 * `RepeatingTask`, which schedules against an absolute run time and makes up
 * every lost tick with zero delay, unbounded (rtc_base/task_utils/
 * repeating_task.cc:86-89, `delay -= lost_time; delay = max(delay, 0)`). The
 * bound is ours: 10 packets, so an event-loop hiccup is made up in full and a
 * real stall does not dump seconds of audio on the receiver at once.
 * Sources saved under _sources/audio-pacing-20260922.
 */
export const WERIFT_MAX_CATCH_UP_MS = 200;

/**
 * Wall-clock RTP audio pacing: packet `n` of a run is due at `start + n × 20 ms`,
 * so the average rate is exactly one packet per 20 ms however late the timer
 * fires. `take(now)` returns how many packets are due and counts them as sent.
 */
export class RtpAudioPacer {
  #startedAt: number | undefined;
  #sent = 0;

  constructor(
    readonly packetMs = WERIFT_PACKET_MS,
    readonly maxCatchUpMs = WERIFT_MAX_CATCH_UP_MS,
  ) {}

  /** Packets due by `now` and not yet sent; the first call of a run sends one at once. */
  take(now: number): number {
    if (this.#startedAt === undefined || now - this.nextDueAt() > this.maxCatchUpMs) {
      this.#startedAt = now;
      this.#sent = 0;
    }
    const due = Math.floor((now - this.#startedAt) / this.packetMs) + 1 - this.#sent;
    if (due <= 0) return 0;
    this.#sent += due;
    return due;
  }

  /** When the next packet is due; `-Infinity` before the first `take` of a run. */
  nextDueAt(): number {
    return this.#startedAt === undefined ? -Infinity : this.#startedAt + this.#sent * this.packetMs;
  }

  /** Forget the run; the next `take` starts a new clock. */
  reset(): void {
    this.#startedAt = undefined;
    this.#sent = 0;
  }
}

/** Convert any PCM16 frame to interleaved 48 kHz stereo by linear interpolation. */
export const toWireFormat = (data: {
  samples: Int16Array;
  sampleRate: number;
  channelCount: number;
}): Int16Array => {
  const { samples, sampleRate, channelCount } = data;
  const inputFrames = Math.floor(samples.length / channelCount);
  if (sampleRate === WERIFT_SAMPLE_RATE && channelCount === WERIFT_CHANNEL_COUNT) {
    return samples;
  }
  const outputFrames = Math.round((inputFrames * WERIFT_SAMPLE_RATE) / sampleRate);
  const out = new Int16Array(outputFrames * WERIFT_CHANNEL_COUNT);
  const ratio = sampleRate / WERIFT_SAMPLE_RATE;
  const leftIndex = 0;
  const rightIndex = channelCount > 1 ? 1 : 0;
  for (let frame = 0; frame < outputFrames; frame += 1) {
    const position = frame * ratio;
    const base = Math.min(Math.floor(position), inputFrames - 1);
    const next = Math.min(base + 1, inputFrames - 1);
    const fraction = position - Math.floor(position);
    const left = samples[base * channelCount + leftIndex]! * (1 - fraction)
      + samples[next * channelCount + leftIndex]! * fraction;
    const right = samples[base * channelCount + rightIndex]! * (1 - fraction)
      + samples[next * channelCount + rightIndex]! * fraction;
    out[frame * 2] = Math.round(left);
    out[frame * 2 + 1] = Math.round(right);
  }
  return out;
};

/**
 * PCM16 in, paced 20 ms Opus RTP out. Frames are accumulated into whole
 * packets; an `RtpAudioPacer` on the monotonic clock decides how many are
 * due, so the wire sees exactly 50 packets/s regardless of how the adapter
 * chunks its writes or how late the timer fires. A timer that fired once per
 * packet (the old `setInterval`) lost every late tick while the RTP timestamp
 * still advanced 960 per packet: @relay's calls on 2026-09-22 sent 48.66-48.98
 * packets/s and the phone's jitter buffer ran dry. Adapters may push
 * far ahead of real time: `queuedMs()` is what has not left yet and
 * `waitForDrain()` resolves once the queued application audio has been
 * written (LiveKit's `AudioSource.queuedDuration` / `waitForPlayout` shape).
 *
 * From `start()` (the transport calls it when the peer first connects) until
 * the track stops, the pump never pauses: a tick with no application audio
 * queued writes an Opus silence frame instead, as a live microphone track
 * does. Cloudflare's SFU refuses to pull a published track that has carried
 * no RTP: `tracks/new` for the remote track returned `empty_track_error` "No
 * track data from remote peer" after about 8.2 s on staging 2026-09-22, and
 * the same pull returned in about 470 ms with silence flowing. Silence and
 * application packets share one sequence and timestamp line, so queued audio
 * replaces silence on the next tick with no gap and no jump.
 */
class WeriftAudioSource implements RelayAudioSourceLike {
  readonly #encoder = new Encoder({
    channels: WERIFT_CHANNEL_COUNT,
    sample_rate: WERIFT_SAMPLE_RATE,
    application: "voip",
  });
  /** 20 ms of digital silence, encoded once by the same encoder and reused. */
  readonly #silence = Buffer.from(this.#encoder.encode(new Int16Array(PACKET_SAMPLES)));
  readonly #track = new MediaStreamTrack({ kind: "audio", id: "microphone", streamId: "relay-call" });
  readonly #packets: Buffer[] = [];
  /** Every RTP packet written, silence included. */
  readonly #rtp = new PacketClock();
  #opusPackets = 0;
  #applicationRtpPackets = 0;
  #silencePackets = 0;
  #pending = new Int16Array(0);
  #sequenceNumber = 1;
  #timestamp = 0;
  #first = true;
  #pump: NodeJS.Timeout | undefined;
  readonly #pacer = new RtpAudioPacer();
  #started = false;
  #stopped = false;
  readonly #drainWaiters = new Set<() => void>();

  stats(): RelayAudioSourceStats {
    return {
      opusPackets: this.#opusPackets,
      rtpPackets: this.#applicationRtpPackets,
      silencePackets: this.#silencePackets,
      firstRtpAt: this.#rtp.firstAt,
      lastRtpAt: this.#rtp.lastAt,
      recentRtpPackets: this.#rtp.recent(),
      queued: this.#packets.length,
      pacerAlive: this.#pump !== undefined,
    };
  }

  createTrack(): RelayMediaStreamTrackLike {
    const track = this.#track;
    const stop = track.stop;
    track.stop = () => {
      this.#stopped = true;
      this.clear();
      this.#stopPump();
      stop();
    };
    return track;
  }

  start(): void {
    if (this.#started || this.#stopped) return;
    this.#started = true;
    this.#startPump();
  }

  queuedMs(): number {
    return this.#packets.length * WERIFT_PACKET_MS
      + (this.#pending.length / WERIFT_CHANNEL_COUNT / WERIFT_SAMPLE_RATE) * 1_000;
  }

  waitForDrain(): Promise<void> {
    this.#flushPending();
    if (this.#drained()) return Promise.resolve();
    return new Promise((resolve) => this.#drainWaiters.add(resolve));
  }

  clear(): void {
    this.#packets.length = 0;
    this.#pending = new Int16Array(0);
    if (!this.#started) this.#stopPump();
    this.#notifyDrained();
  }

  onData(data: WeriftAudioSourceData): void {
    if (this.#stopped) return;
    const wire = toWireFormat(data);
    const merged = new Int16Array(this.#pending.length + wire.length);
    merged.set(this.#pending);
    merged.set(wire, this.#pending.length);
    let offset = 0;
    while (merged.length - offset >= PACKET_SAMPLES) {
      const frame = merged.subarray(offset, offset + PACKET_SAMPLES);
      this.#packets.push(Buffer.from(this.#encoder.encode(frame)));
      this.#opusPackets += 1;
      offset += PACKET_SAMPLES;
    }
    this.#pending = merged.slice(offset);
    this.#startPump();
  }

  /** Pad a sub-packet remainder with silence so the tail of a segment reaches the wire. */
  #flushPending(): void {
    if (this.#stopped || this.#pending.length === 0) return;
    const padded = new Int16Array(PACKET_SAMPLES);
    padded.set(this.#pending);
    this.#pending = new Int16Array(0);
    this.#packets.push(Buffer.from(this.#encoder.encode(padded)));
    this.#opusPackets += 1;
    this.#startPump();
  }

  /** Application audio only: the silence the started pump keeps writing never counts. */
  #drained(): boolean {
    return this.#packets.length === 0
      && this.#pending.length === 0
      && (this.#started || this.#pump === undefined);
  }

  #notifyDrained(): void {
    if (!this.#drained()) return;
    for (const resolve of [...this.#drainWaiters]) {
      this.#drainWaiters.delete(resolve);
      resolve();
    }
  }

  /**
   * The first packet of a run leaves at once; after that each wake sends
   * every packet the pacer says is due and sleeps until the next one is due,
   * the absolute schedule of libwebrtc's `RepeatingTask`. Before `start()` the
   * pump stops once the queue is empty; after it, the pump runs until the
   * track stops.
   */
  #startPump(): void {
    if (this.#pump || this.#stopped) return;
    if (!this.#started && this.#packets.length === 0) return;
    this.#tick();
  }

  #tick(): void {
    if (this.#stopped) return;
    const due = this.#pacer.take(performance.now());
    for (let sent = 0; sent < due; sent += 1) {
      if (!this.#sendNext()) break;
    }
    if (this.#packets.length === 0) {
      if (!this.#started) {
        this.#stopPump();
        this.#notifyDrained();
        return;
      }
      this.#notifyDrained();
    }
    const delay = Math.max(0, Math.ceil(this.#pacer.nextDueAt() - performance.now()));
    this.#pump = setTimeout(() => this.#tick(), delay);
    this.#pump.unref?.();
  }

  #stopPump(): void {
    this.#pacer.reset();
    if (!this.#pump) return;
    clearTimeout(this.#pump);
    this.#pump = undefined;
  }

  /** Writes one packet, queued audio first, else silence once started; false when nothing was written. */
  #sendNext(): boolean {
    if (this.#stopped) return false;
    const application = this.#packets.shift();
    if (!application && !this.#started) return false;
    const header = new RtpHeader({
      payloadType: LOCAL_PAYLOAD_TYPE,
      sequenceNumber: this.#sequenceNumber,
      timestamp: this.#timestamp,
      ssrc: 0,
      marker: this.#first,
    });
    this.#first = false;
    this.#sequenceNumber = (this.#sequenceNumber + 1) & 0xffff;
    this.#timestamp = (this.#timestamp + PACKET_FRAMES) >>> 0;
    this.#track.writeRtp(new RtpPacket(header, application ?? this.#silence));
    if (application) this.#applicationRtpPackets += 1;
    else this.#silencePackets += 1;
    this.#rtp.mark();
    return true;
  }
}

/** Opus RTP in, PCM16 in the requested format (default 48 kHz stereo) out, one `ondata` per packet. */
class WeriftAudioSink implements RelayAudioSinkLike {
  ondata: RelayAudioSinkLike["ondata"] = null;
  readonly #decoder: Decoder;
  readonly #rtp = new PacketClock();
  #decodeFailures = 0;
  readonly #unsubscribe: () => void;

  stats(): RelayAudioSinkStats {
    return {
      rtpPackets: this.#rtp.count,
      decodeFailures: this.#decodeFailures,
      firstRtpAt: this.#rtp.firstAt,
      lastRtpAt: this.#rtp.lastAt,
      recentRtpPackets: this.#rtp.recent(),
    };
  }

  constructor(
    track: MediaStreamTrack,
    format: RelayInboundAudioFormat = { sampleRate: WERIFT_SAMPLE_RATE, channelCount: WERIFT_CHANNEL_COUNT },
  ) {
    const { sampleRate, channelCount } = format;
    this.#decoder = new Decoder({ channels: channelCount, sample_rate: sampleRate });
    const { unSubscribe } = track.onReceiveRtp.subscribe((rtp) => {
      this.#rtp.mark();
      const handler = this.ondata;
      if (!handler || !rtp.payload?.length) return;
      const packet = OpusRtpPayload.deSerialize(rtp.payload);
      let bytes: Uint8Array;
      try {
        bytes = this.#decoder.decode(packet.payload);
      } catch {
        this.#decodeFailures += 1;
        return;
      }
      const samples = new Int16Array(bytes.byteLength >> 1);
      new Uint8Array(samples.buffer).set(bytes.subarray(0, samples.byteLength));
      handler({
        samples,
        sampleRate,
        bitsPerSample: 16,
        channelCount,
        numberOfFrames: samples.length / channelCount,
      });
    });
    this.#unsubscribe = unSubscribe;
  }

  stop(): void {
    this.ondata = null;
    this.#unsubscribe();
  }
}

/**
 * Video codecs the peer can accept in a pull offer. Nothing decodes video: the
 * transport only answers the person's `video` m-line receive-only and ignores
 * the track (PROTOCOL.md section 5). werift matches a remote codec by MIME
 * type alone (`findCodecByMimeType` in `TransceiverManager.setRemoteRTP`) and
 * throws "negotiate codecs failed." for a media section with no local codec
 * of its kind, so an audio-only codec list cannot answer a video m-line.
 */
const RECEIVE_VIDEO_MIME_TYPES = ["video/VP8", "video/VP9", "video/H264", "video/AV1"] as const;

export const createWeriftPeerConnection = (
  config: RelayPeerConnectionConfig = { iceServers: [], iceTransportPolicy: "all" },
): RTCPeerConnection =>
  new RTCPeerConnection({
    bundlePolicy: "max-bundle",
    iceServers: config.iceServers,
    iceTransportPolicy: config.iceTransportPolicy,
    codecs: {
      audio: [
        new RTCRtpCodecParameters({
          mimeType: "audio/opus",
          clockRate: WERIFT_SAMPLE_RATE,
          channels: WERIFT_CHANNEL_COUNT,
        }),
      ],
      video: RECEIVE_VIDEO_MIME_TYPES.map((mimeType) => new RTCRtpCodecParameters({ mimeType, clockRate: 90_000 })),
    },
  });

export const createWeriftWebRTCFactory = (): RelayWebRTCFactory => ({
  createPeerConnection: (config) => createWeriftPeerConnection(config) as unknown as RelayPeerConnectionLike,
  createAudioSource: () => new WeriftAudioSource(),
  createAudioSink: (track, format) => new WeriftAudioSink(track as unknown as MediaStreamTrack, format),
});
