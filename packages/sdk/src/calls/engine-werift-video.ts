/**
 * Video for the werift engine: `node-webcodecs` 1.3.0 encodes and decodes
 * (its static build: LGPL FFmpeg with openh264 and libvpx), `rtp-packet`
 * packetizes, `video-rtp.ts` depacketizes, werift carries RTP and RTCP.
 *
 * Choices measured on 2026-09-22 (/tmp/video-spike-webcodecs, the spike that
 * picked this engine), each kept here:
 * - `NODE_WEBCODECS_FORCE=static` selects the bundled FFmpeg
 *   (node-webcodecs dist/native.js `load()`; the default order tries a
 *   dynamic build linked against system FFmpeg first).
 * - `hardwareAcceleration: "prefer-software"` on encoder and decoder: on a
 *   Mac, VideoToolbox otherwise takes the stream.
 * - H.264 is sent as constrained baseline, Annex-B; the codec string FFmpeg
 *   reports for H.264 is "MPEG4/ISO/AVC", so the codec is never matched by
 *   FFmpeg's name, only by the negotiated MIME type.
 * - The H.264 level in the stream is OpenH264's own choice for the frame
 *   size, as in libwebrtc, whose OpenH264 encoder sets no level
 *   (modules/video_coding/codecs/h264/h264_encoder_impl.cc): measured on
 *   2026-09-26, the SPS carries level 3.1 at 1280x720 and 4.0 at 1920x1080
 *   whatever level the codec string names. The string names level 4.0
 *   (`H264_ENCODER_CODEC`), the level of 1080p at 30 fps.
 * - With no `videoEncoding`, the bitrate and framerate are LiveKit's preset
 *   for the frame size being sent (video-presets.ts); a `videoEncoding` field
 *   the caller sets wins over the preset's.
 * - A keyframe every 1 s, and on every PLI or FIR from the SFU.
 * - The send codec is the first codec of the SFU's answer (werift
 *   rtpSender.js:408 `this.codec = params.codecs[0]`).
 * - The receive codec is learned from the payload type of the first RTP
 *   packet, looked up in the pulled m-line's codecs: the SFU's pull offer
 *   lists every codec (spike receiver.mjs).
 * - werift sends no PLI on loss by itself: the receiver sends one when the
 *   stream starts, when a frame is dropped and on a decode error, then every
 *   1 s until a keyframe decodes (spike receiver.mjs `pliTimer`).
 */
import {
  MediaStreamTrack,
  type RTCPeerConnection,
  type RTCRtpTransceiver,
  RtpPacket,
  type RtcpPacket,
} from "werift";
import { JitterBuffer } from "rtp-packet";
import type { RelayMediaStreamTrackLike } from "./transport.js";
import {
  type RelayVideoFactory,
  type RelayVideoReceiverLike,
  type RelayVideoReceiverStats,
  type RelayVideoSenderLike,
  type RelayVideoSenderStats,
  type TrackPublishOptions,
  VideoCodec,
  type VideoEncoding,
  type VideoFrameEvent,
} from "./video.js";
import { defaultVideoEncoding } from "./video-presets.js";
import { VideoBufferType, VideoFrame, VideoRotation, videoFrameLength } from "./video-frame.js";
import {
  type AssembledVideoFrame,
  type RelayVideoCodecName,
  VIDEO_CLOCK_RATE,
  VideoFrameAssembler,
  type VideoPacketizer,
  type VideoRtpPacket,
  createVideoPacketizer,
} from "./video-rtp.js";

type WebCodecs = typeof import("node-webcodecs");
type WcVideoEncoder = InstanceType<WebCodecs["VideoEncoder"]>;
type WcVideoDecoder = InstanceType<WebCodecs["VideoDecoder"]>;
type WcVideoFrame = InstanceType<WebCodecs["VideoFrame"]>;
type WcPixelFormat = "I420" | "RGBA" | "BGRA";

export const KEYFRAME_INTERVAL_MS = 1_000;
export const KEYFRAME_REQUEST_INTERVAL_MS = 1_000;
/**
 * Constrained baseline (profile_idc 66, constraint_set0 and set1), level 4.0:
 * ITU-T H.264 Table A-1 allows 8,192 macroblocks a frame and 245,760 a second
 * at level 4.0, and 1920x1080 at 30 fps is 8,160 and 244,800.
 */
export const H264_ENCODER_CODEC = "avc1.42e028";
/** Frames waiting in the encoder before new captures are dropped instead of queued. */
const MAX_ENCODE_QUEUE = 3;
/** Reorder window ahead of the frame assembler (rtp-packet `JitterBuffer` default). */
const JITTER_LATENCY_MS = 50;
const STATS_WINDOW_MS = 5_000;
const CVO_URI = "urn:3gpp:video-orientation";

let webCodecs: Promise<WebCodecs> | undefined;

/** Loads node-webcodecs once, on first video use, so audio-only calls never load FFmpeg. */
export const loadWebCodecs = (): Promise<WebCodecs> => {
  webCodecs ??= (async () => {
    process.env.NODE_WEBCODECS_FORCE ??= "static";
    try {
      const module = await import("node-webcodecs");
      if (!module.isNativeAvailable()) throw new Error("native binding did not load");
      return module;
    } catch (error) {
      webCodecs = undefined;
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Relay video needs the optional dependency node-webcodecs (prebuilt for darwin-arm64, linux-x64 and linux-arm64): ${reason}`,
      );
    }
  })();
  return webCodecs;
};

class FrameClock {
  count = 0;
  firstAt: number | undefined;
  lastAt: number | undefined;
  readonly #recent: number[] = [];

  mark(now = Date.now()): void {
    this.count += 1;
    this.firstAt ??= now;
    this.lastAt = now;
    this.#recent.push(now);
    this.recent(now);
  }

  recent(now = Date.now()): number {
    const floor = now - STATS_WINDOW_MS;
    let drop = 0;
    while (drop < this.#recent.length && this.#recent[drop]! < floor) drop += 1;
    if (drop) this.#recent.splice(0, drop);
    return this.#recent.length;
  }
}

const codecOf = (mimeType: string | undefined): RelayVideoCodecName | undefined => {
  const lower = mimeType?.toLowerCase();
  if (lower === "video/h264") return "h264";
  if (lower === "video/vp8") return "vp8";
  return undefined;
};

/** WebCodecs pixel format for a LiveKit buffer type the encoder takes directly. */
const encoderFormat = (type: VideoBufferType): WcPixelFormat | undefined => {
  if (type === VideoBufferType.I420) return "I420";
  if (type === VideoBufferType.RGBA) return "RGBA";
  if (type === VideoBufferType.BGRA) return "BGRA";
  return undefined;
};

const monotonicUs = (): number => Math.round(performance.now() * 1_000);

/**
 * Raw frames in, H.264 or VP8 RTP out on one werift track. One sender lives
 * for the whole call; a restart binds it to the new peer's transceiver.
 */
export class WeriftVideoSender implements RelayVideoSenderLike {
  readonly track: RelayMediaStreamTrackLike;
  readonly #track: MediaStreamTrack;
  readonly #wc: WebCodecs;
  readonly #encoding: VideoEncoding | undefined;
  readonly #preferred: RelayVideoCodecName;
  readonly #ssrc = (Math.random() * 0xffffffff) >>> 0;
  #transceiver: RTCRtpTransceiver | undefined;
  #unsubscribe: Array<() => void> = [];
  #encoder: WcVideoEncoder | undefined;
  #encoderKey = "";
  #packetizer: VideoPacketizer | undefined;
  #packetizerCodec: RelayVideoCodecName | undefined;
  #enabled = true;
  #closed = false;
  #keyframeWanted = true;
  #lastKeyframeAt = Number.NEGATIVE_INFINITY;
  #lastTimestampUs = 0;
  #codec: RelayVideoCodecName | undefined;
  #width: number | undefined;
  #height: number | undefined;
  #captured = 0;
  #dropped = 0;
  #keyframes = 0;
  #rtpPackets = 0;
  #bytes = 0;
  #keyframeRequests = 0;
  #encodeErrors = 0;
  readonly #encoded = new FrameClock();

  constructor(wc: WebCodecs, options: TrackPublishOptions = {}) {
    this.#wc = wc;
    this.#encoding = options.videoEncoding;
    this.#preferred = options.videoCodec === VideoCodec.VP8 ? "vp8" : "h264";
    this.#track = new MediaStreamTrack({ kind: "video", id: "camera", streamId: "relay-call" });
    this.track = this.#track as unknown as RelayMediaStreamTrackLike;
  }

  /**
   * Offer the codecs this sender can encode, the preferred one first (werift
   * fills an empty `transceiver.codecs` from the peer's config at
   * `createOffer`, peerConnection.js:520-523, so setting it here wins).
   */
  bind(transceiver: unknown, peer: unknown): void {
    for (const unsubscribe of this.#unsubscribe) unsubscribe();
    this.#unsubscribe = [];
    const bound = transceiver as RTCRtpTransceiver;
    const rank = (mimeType: string): number => (codecOf(mimeType) === this.#preferred ? 0 : 1);
    bound.codecs = ((peer as RTCPeerConnection).config.codecs.video ?? [])
      .filter((codec) => codecOf(codec.mimeType) !== undefined)
      .sort((a, b) => rank(a.mimeType) - rank(b.mimeType));
    this.#transceiver = bound;
    this.#keyframeWanted = true;
    this.#packetizer = undefined;
    this.#packetizerCodec = undefined;
    const pli = bound.sender.onPictureLossIndication.subscribe(() => this.#requestKeyframe());
    const rtcp = bound.sender.onRtcp.subscribe((packet: RtcpPacket) => {
      // Payload-specific feedback (206) with FMT 4 is a Full Intra Request (RFC 5104 section 4.3.1).
      const feedback = (packet as { type?: number; feedback?: { count?: number } }).feedback;
      if (packet.type === 206 && feedback?.count === 4) this.#requestKeyframe();
    });
    this.#unsubscribe.push(pli.unSubscribe, rtcp.unSubscribe);
  }

  setEnabled(enabled: boolean): void {
    if (enabled && !this.#enabled) this.#keyframeWanted = true;
    this.#enabled = enabled;
  }

  capture(frame: VideoFrame, timestampUs: bigint, rotation: VideoRotation): void {
    this.#captured += 1;
    if (this.#closed || !this.#enabled) {
      this.#dropped += 1;
      return;
    }
    if (rotation !== VideoRotation.VIDEO_ROTATION_0) {
      throw new Error("Relay video sends upright frames only; rotate the frame before captureFrame.");
    }
    // The first codec of the answer; undefined until the SFU has answered.
    const codec = codecOf(this.#transceiver?.sender.codec?.mimeType);
    if (!codec) {
      this.#dropped += 1;
      return;
    }
    this.#codec = codec;
    let input = frame;
    let format = encoderFormat(frame.type);
    if (!format) {
      input = frame.convert(VideoBufferType.I420);
      format = "I420";
    }
    const expected = videoFrameLength(input.type, input.width, input.height);
    if (input.data.length < expected) {
      throw new Error(`VideoFrame data holds ${input.data.length} bytes; ${input.width}x${input.height} needs ${expected}.`);
    }
    const encoder = this.#ensureEncoder(codec, input.width, input.height);
    if (encoder.encodeQueueSize >= MAX_ENCODE_QUEUE) {
      this.#dropped += 1;
      return;
    }
    let us = timestampUs === BigInt(0) ? monotonicUs() : Number(timestampUs);
    if (us <= this.#lastTimestampUs) us = this.#lastTimestampUs + 1;
    this.#lastTimestampUs = us;
    const now = Date.now();
    const keyFrame = this.#keyframeWanted || now - this.#lastKeyframeAt >= KEYFRAME_INTERVAL_MS;
    if (keyFrame) {
      this.#keyframeWanted = false;
      this.#lastKeyframeAt = now;
    }
    const wcFrame: WcVideoFrame = new this.#wc.VideoFrame(input.data.subarray(0, expected), {
      format,
      codedWidth: input.width,
      codedHeight: input.height,
      timestamp: us,
    });
    try {
      encoder.encode(wcFrame, { keyFrame });
    } finally {
      wcFrame.close();
    }
  }

  stats(): RelayVideoSenderStats {
    return {
      codec: this.#codec,
      framesCaptured: this.#captured,
      framesEncoded: this.#encoded.count,
      framesDropped: this.#dropped,
      keyframes: this.#keyframes,
      rtpPackets: this.#rtpPackets,
      bytes: this.#bytes,
      keyframeRequests: this.#keyframeRequests,
      encodeErrors: this.#encodeErrors,
      firstFrameAt: this.#encoded.firstAt,
      lastFrameAt: this.#encoded.lastAt,
      recentFrames: this.#encoded.recent(),
      width: this.#width,
      height: this.#height,
    };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const unsubscribe of this.#unsubscribe) unsubscribe();
    this.#unsubscribe = [];
    this.#closeEncoder();
    this.#track.stop();
  }

  #requestKeyframe(): void {
    this.#keyframeRequests += 1;
    this.#keyframeWanted = true;
  }

  #ensureEncoder(codec: RelayVideoCodecName, width: number, height: number): WcVideoEncoder {
    const key = `${codec}:${width}x${height}`;
    if (this.#encoder && this.#encoderKey === key && this.#encoder.state === "configured") return this.#encoder;
    this.#closeEncoder();
    const encoder = new this.#wc.VideoEncoder({
      output: (chunk) => this.#output(codec, chunk),
      error: () => {
        this.#encodeErrors += 1;
        this.#keyframeWanted = true;
        if (this.#encoder === encoder) this.#encoder = undefined;
      },
    });
    const preset = defaultVideoEncoding(width, height);
    encoder.configure({
      codec: codec === "h264" ? H264_ENCODER_CODEC : "vp8",
      width,
      height,
      bitrate: Number(this.#encoding?.maxBitrate ?? preset.maxBitrate),
      framerate: this.#encoding?.maxFramerate ?? preset.maxFramerate,
      latencyMode: "realtime",
      hardwareAcceleration: "prefer-software",
      ...(codec === "h264" ? { avc: { format: "annexb" as const } } : {}),
    });
    this.#encoder = encoder;
    this.#encoderKey = key;
    this.#width = width;
    this.#height = height;
    this.#keyframeWanted = true;
    return encoder;
  }

  #closeEncoder(): void {
    const encoder = this.#encoder;
    this.#encoder = undefined;
    this.#encoderKey = "";
    if (!encoder || encoder.state === "closed") return;
    try { encoder.close(); } catch { /* already closed */ }
  }

  #output(codec: RelayVideoCodecName, chunk: InstanceType<WebCodecs["EncodedVideoChunk"]>): void {
    if (this.#closed) return;
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    if (this.#packetizerCodec !== codec || !this.#packetizer) {
      // werift's sender rewrites SSRC, payload type, sequence and timestamp
      // base (rtpSender.js:544-549), so these are local placeholders.
      this.#packetizer = createVideoPacketizer(codec, { ssrc: this.#ssrc, payloadType: 96 });
      this.#packetizerCodec = codec;
    }
    const keyframe = chunk.type === "key";
    const packets = this.#packetizer.packetize(data, chunk.timestamp, keyframe);
    for (const packet of packets) {
      this.#track.writeRtp(RtpPacket.deSerialize(packet));
      this.#rtpPackets += 1;
      this.#bytes += packet.length;
    }
    if (keyframe) this.#keyframes += 1;
    this.#encoded.mark();
  }
}

/**
 * One pulled video m-line: RTP in, decoded I420 frames out. RTP is counted
 * always; it is reordered, assembled and decoded only while active.
 */
export class WeriftVideoReceiver implements RelayVideoReceiverLike {
  onframe: RelayVideoReceiverLike["onframe"] = null;
  readonly #track: MediaStreamTrack;
  readonly #transceiver: RTCRtpTransceiver | undefined;
  readonly #unsubscribe: () => void;
  #wc: WebCodecs | undefined;
  #active = false;
  #stopped = false;
  #payloadType: number | undefined;
  #codec: RelayVideoCodecName | undefined;
  #codecLabel: string | undefined;
  #codecString = "";
  #ssrc: number | undefined;
  #jitter: JitterBuffer<VideoRtpPacket> | undefined;
  #assembler: VideoFrameAssembler | undefined;
  #decoder: WcVideoDecoder | undefined;
  #waitingForKeyframe = true;
  #lastKeyframeRequestAt = Number.NEGATIVE_INFINITY;
  #keyframeTimer: NodeJS.Timeout | undefined;
  #rotation = VideoRotation.VIDEO_ROTATION_0;
  #firstRtpTimestamp: number | undefined;
  #lastRtpTimestamp = 0;
  #rtpTimestampWraps = 0;
  #outputChain: Promise<void> = Promise.resolve();
  #rtpPackets = 0;
  #skippedDeltas = 0;
  #decodeErrors = 0;
  #keyframeRequests = 0;
  #width: number | undefined;
  #height: number | undefined;
  readonly #decoded = new FrameClock();

  constructor(track: MediaStreamTrack, transceiver: RTCRtpTransceiver | undefined) {
    this.#track = track;
    this.#transceiver = transceiver;
    const { unSubscribe } = track.onReceiveRtp.subscribe((rtp, extensions) => {
      this.#rtpPackets += 1;
      if (!this.#active || this.#stopped) return;
      this.#receive(rtp, extensions as Record<string, unknown> | undefined);
    });
    this.#unsubscribe = unSubscribe;
  }

  setActive(active: boolean): void {
    if (this.#stopped || active === this.#active) return;
    this.#active = active;
    if (!active) {
      this.#resetPipeline();
      return;
    }
    void loadWebCodecs().then((wc) => {
      this.#wc = wc;
      if (this.#active) this.#requestKeyframe();
    }, () => {
      this.#decodeErrors += 1;
    });
  }

  stats(): RelayVideoReceiverStats {
    return {
      codec: this.#codecLabel,
      rtpPackets: this.#rtpPackets,
      framesAssembled: this.#assembler?.frames ?? 0,
      framesDropped: (this.#assembler?.dropped ?? 0) + this.#skippedDeltas,
      framesDecoded: this.#decoded.count,
      decodeErrors: this.#decodeErrors,
      keyframeRequests: this.#keyframeRequests,
      firstFrameAt: this.#decoded.firstAt,
      lastFrameAt: this.#decoded.lastAt,
      recentFrames: this.#decoded.recent(),
      width: this.#width,
      height: this.#height,
    };
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.onframe = null;
    this.#unsubscribe();
    this.#resetPipeline();
  }

  #receive(rtp: RtpPacket, extensions: Record<string, unknown> | undefined): void {
    const header = rtp.header;
    if (this.#payloadType === undefined) {
      this.#payloadType = header.payloadType;
      const codec = this.#transceiver?.codecs.find((candidate) => candidate.payloadType === header.payloadType);
      this.#codecLabel = codec?.mimeType ?? `pt ${header.payloadType}`;
      this.#codec = codecOf(codec?.mimeType);
      const profile = /profile-level-id=([0-9a-f]{6})/i.exec(codec?.parameters ?? "")?.[1];
      this.#codecString = this.#codec === "vp8" ? "vp8" : `avc1.${(profile ?? "42e01f").toLowerCase()}`;
    }
    if (header.payloadType !== this.#payloadType || !this.#codec || !rtp.payload?.length) return;
    this.#ssrc = header.ssrc;
    const orientation = extensions?.[CVO_URI] as { r1?: number; r0?: number } | undefined;
    if (orientation) this.#rotation = (((orientation.r1 ?? 0) << 1) | (orientation.r0 ?? 0)) as VideoRotation;
    if (!this.#jitter) {
      const codec = this.#codec;
      this.#assembler = new VideoFrameAssembler(codec, (frame) => this.#frame(frame), () => {
        this.#waitingForKeyframe = true;
        this.#requestKeyframe();
      });
      this.#jitter = new JitterBuffer<VideoRtpPacket>({
        latency: JITTER_LATENCY_MS,
        output: (packet) => this.#assembler?.push(packet),
      });
      this.#requestKeyframe();
    }
    this.#jitter.push({
      sequenceNumber: header.sequenceNumber,
      timestamp: header.timestamp,
      marker: header.marker,
      payload: rtp.payload,
    });
  }

  #frame(frame: AssembledVideoFrame): void {
    const wc = this.#wc;
    if (!wc || !this.#active) return;
    if (this.#waitingForKeyframe && !frame.keyframe) {
      this.#skippedDeltas += 1;
      return;
    }
    if (!this.#decoder || this.#decoder.state === "closed") {
      if (!frame.keyframe) {
        this.#skippedDeltas += 1;
        return;
      }
      this.#decoder = this.#createDecoder(wc);
    }
    if (frame.keyframe) {
      this.#waitingForKeyframe = false;
      this.#stopKeyframeTimer();
    }
    const timestampUs = this.#timestampUs(frame.timestamp);
    try {
      this.#decoder.decode(new wc.EncodedVideoChunk({
        type: frame.keyframe ? "key" : "delta",
        timestamp: timestampUs,
        data: frame.data,
      }));
    } catch {
      this.#decodeFailed();
    }
  }

  #createDecoder(wc: WebCodecs): WcVideoDecoder {
    const decoder: WcVideoDecoder = new wc.VideoDecoder({
      output: (output) => {
        const rotation = this.#rotation;
        this.#outputChain = this.#outputChain.then(() => this.#emit(output, rotation));
      },
      error: () => {
        if (this.#decoder === decoder) this.#decodeFailed();
      },
    });
    decoder.configure({ codec: this.#codecString, hardwareAcceleration: "prefer-software", optimizeForLatency: true });
    return decoder;
  }

  async #emit(output: WcVideoFrame, rotation: VideoRotation): Promise<void> {
    try {
      const width = output.codedWidth;
      const height = output.codedHeight;
      const options = { format: "I420" as const };
      const data = new Uint8Array(output.allocationSize(options));
      await output.copyTo(data, options);
      const tight = videoFrameLength(VideoBufferType.I420, width, height);
      const frame = new VideoFrame(data.length === tight ? data : data.subarray(0, tight), width, height, VideoBufferType.I420);
      this.#width = width;
      this.#height = height;
      this.#decoded.mark();
      const event: VideoFrameEvent = { frame, timestampUs: BigInt(output.timestamp), rotation };
      if (!this.#stopped && this.#active) this.onframe?.(event);
    } catch {
      this.#decodeErrors += 1;
    } finally {
      output.close();
    }
  }

  #decodeFailed(): void {
    this.#decodeErrors += 1;
    const decoder = this.#decoder;
    this.#decoder = undefined;
    if (decoder && decoder.state !== "closed") {
      try { decoder.close(); } catch { /* already closed */ }
    }
    this.#waitingForKeyframe = true;
    this.#requestKeyframe();
  }

  /** RTP timestamp (90 kHz, wrapping at 2^32) to microseconds since this stream's first frame. */
  #timestampUs(rtpTimestamp: number): number {
    if (this.#firstRtpTimestamp === undefined) this.#firstRtpTimestamp = rtpTimestamp;
    if (rtpTimestamp < this.#lastRtpTimestamp && this.#lastRtpTimestamp - rtpTimestamp > 0x80000000) {
      this.#rtpTimestampWraps += 1;
    }
    this.#lastRtpTimestamp = rtpTimestamp;
    const ticks = this.#rtpTimestampWraps * 0x100000000 + rtpTimestamp - this.#firstRtpTimestamp;
    return Math.round((ticks * 1_000_000) / VIDEO_CLOCK_RATE);
  }

  /**
   * PLI to the sender, at once unless one left in the last 1 s; while no
   * keyframe has arrived, a timer repeats it every 1 s.
   */
  #requestKeyframe(): void {
    if (this.#stopped || !this.#active) return;
    if (Date.now() - this.#lastKeyframeRequestAt >= KEYFRAME_REQUEST_INTERVAL_MS) this.#sendPli();
    if (this.#keyframeTimer) return;
    this.#keyframeTimer = setInterval(() => {
      if (!this.#waitingForKeyframe || !this.#active) {
        this.#stopKeyframeTimer();
        return;
      }
      this.#sendPli();
    }, KEYFRAME_REQUEST_INTERVAL_MS);
    this.#keyframeTimer.unref?.();
  }

  #sendPli(): void {
    const ssrc = this.#ssrc ?? this.#track.ssrc;
    const receiver = this.#transceiver?.receiver;
    if (ssrc === undefined || !receiver) return;
    this.#lastKeyframeRequestAt = Date.now();
    this.#keyframeRequests += 1;
    void receiver.sendRtcpPLI(ssrc).catch(() => undefined);
  }

  #stopKeyframeTimer(): void {
    if (!this.#keyframeTimer) return;
    clearInterval(this.#keyframeTimer);
    this.#keyframeTimer = undefined;
  }

  #resetPipeline(): void {
    this.#stopKeyframeTimer();
    this.#jitter?.close();
    this.#jitter = undefined;
    this.#assembler?.reset();
    const decoder = this.#decoder;
    this.#decoder = undefined;
    if (decoder && decoder.state !== "closed") {
      try { decoder.close(); } catch { /* already closed */ }
    }
    this.#waitingForKeyframe = true;
  }
}

export const createWeriftVideoFactory = (): RelayVideoFactory => ({
  createVideoSender: async (options) => new WeriftVideoSender(await loadWebCodecs(), options),
  createVideoReceiver: (track, transceiver) =>
    new WeriftVideoReceiver(track as unknown as MediaStreamTrack, transceiver as RTCRtpTransceiver | undefined),
});
