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
 *   packet; `Decoder.decode(packet)` returns interleaved PCM16 bytes.
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
 * packets; a timer drains one packet every 20 ms so the wire sees a steady
 * cadence regardless of how the adapter chunks its writes.
 */
class WeriftAudioSource implements RelayAudioSourceLike {
  readonly #encoder = new Encoder({
    channels: WERIFT_CHANNEL_COUNT,
    sample_rate: WERIFT_SAMPLE_RATE,
    application: "voip",
  });
  readonly #track = new MediaStreamTrack({ kind: "audio", id: "microphone", streamId: "relay-call" });
  readonly #packets: Buffer[] = [];
  readonly #rtp = new PacketClock();
  #opusPackets = 0;
  #pending = new Int16Array(0);
  #sequenceNumber = 1;
  #timestamp = 0;
  #first = true;
  #pump: NodeJS.Timeout | undefined;
  #stopped = false;

  stats(): RelayAudioSourceStats {
    return {
      opusPackets: this.#opusPackets,
      rtpPackets: this.#rtp.count,
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
      this.#packets.length = 0;
      this.#pending = new Int16Array(0);
      this.#stopPump();
      stop();
    };
    return track;
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

  #startPump(): void {
    if (this.#pump || this.#packets.length === 0) return;
    this.#sendNext();
    if (this.#packets.length === 0) return;
    this.#pump = setInterval(() => {
      this.#sendNext();
      if (this.#packets.length === 0) this.#stopPump();
    }, WERIFT_PACKET_MS);
    this.#pump.unref?.();
  }

  #stopPump(): void {
    if (!this.#pump) return;
    clearInterval(this.#pump);
    this.#pump = undefined;
  }

  #sendNext(): void {
    const payload = this.#packets.shift();
    if (!payload || this.#stopped) return;
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
    this.#track.writeRtp(new RtpPacket(header, payload));
    this.#rtp.mark();
  }
}

/** Opus RTP in, PCM16 (48 kHz stereo) out, one `ondata` per packet. */
class WeriftAudioSink implements RelayAudioSinkLike {
  ondata: RelayAudioSinkLike["ondata"] = null;
  readonly #decoder = new Decoder({ channels: WERIFT_CHANNEL_COUNT, sample_rate: WERIFT_SAMPLE_RATE });
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

  constructor(track: MediaStreamTrack) {
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
        sampleRate: WERIFT_SAMPLE_RATE,
        bitsPerSample: 16,
        channelCount: WERIFT_CHANNEL_COUNT,
        numberOfFrames: samples.length / WERIFT_CHANNEL_COUNT,
      });
    });
    this.#unsubscribe = unSubscribe;
  }

  stop(): void {
    this.ondata = null;
    this.#unsubscribe();
  }
}

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
    },
  });

export const createWeriftWebRTCFactory = (): RelayWebRTCFactory => ({
  createPeerConnection: (config) => createWeriftPeerConnection(config) as unknown as RelayPeerConnectionLike,
  createAudioSource: () => new WeriftAudioSource(),
  createAudioSink: (track) => new WeriftAudioSink(track as unknown as MediaStreamTrack),
});
