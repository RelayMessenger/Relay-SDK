/**
 * Video tracks for Relay calls, with LiveKit's public API shape.
 *
 * Names and semantics copied from `@livekit/rtc-node` 0.13.35
 * (node_modules/@livekit/rtc-node/src):
 * - video_source.ts:18-75: `new VideoSource(width, height)`,
 *   `captureFrame(frame, timestampUs = BigInt(0), rotation = VIDEO_ROTATION_0)`
 *   which throws "VideoSource is closed" after `close()`.
 * - track.ts:241-268: `LocalVideoTrack.createVideoTrack(name, source)` and
 *   `close(closeSource = true)`.
 * - video_stream.ts:12-16 and :94-98: `VideoFrameEvent { frame, timestampUs,
 *   rotation }` and `class VideoStream extends ReadableStream<VideoFrameEvent>`
 *   built from a remote track, read with `for await`.
 * - participant.ts:737 `publishTrack(track, options)` and :783
 *   `unpublishTrack(...)`; the publish options `videoCodec` and
 *   `videoEncoding { maxBitrate, maxFramerate }` from
 *   @livekit/rtc-ffi-bindings proto/room_pb.d.ts:1792-1859, and `VideoCodec`
 *   (VP8 = 0, H264 = 1) from proto/video_frame_pb.d.ts:28-50.
 * The optional `{ capacity, format }` of `VideoStream` is LiveKit's Python SDK
 * (livekit-rtc/livekit/rtc/video_stream.py:42-60, `RingQueue` in _utils.py:78-94:
 * capacity 0 keeps every frame, a positive capacity drops the oldest).
 *
 * Relay semantics (PROTOCOL.md sections 1-2, _artifacts/calls-facetime-20260922):
 * a participant publishes at most one `video` track; publishing it the first
 * time negotiates it with an add-track offer and announces `userUpdate
 * { video: true }`; unpublishing stops sending and announces `video: false`
 * but leaves the track negotiated, so publishing again only resumes.
 */
import { ReadableStream } from "node:stream/web";
import type { RelayMediaStreamTrackLike } from "./transport.js";
import { VideoBufferType, VideoFrame, VideoRotation } from "./video-frame.js";

export { VideoBufferType, VideoFrame, VideoRotation } from "./video-frame.js";

/** Same names and numbers as LiveKit's `VideoCodec`; Relay sends these two. */
export enum VideoCodec {
  VP8 = 0,
  H264 = 1,
}

/**
 * LiveKit's `VideoEncoding`. A field left out takes LiveKit's camera preset
 * for the frame size being sent (video-presets.ts), for example 3 Mbps at
 * 30 fps for 1920x1080, 1.7 Mbps at 30 fps for 1280x720 and 450 kbps at
 * 20 fps for 640x360.
 */
export interface VideoEncoding {
  /** Encoder target, bits per second. */
  maxBitrate?: number | bigint;
  /** Encoder rate-control hint, frames per second. */
  maxFramerate?: number;
}

/** The subset of LiveKit's `TrackPublishOptions` a Relay call honours. */
export interface TrackPublishOptions {
  /**
   * Preferred codec. Defaults to H.264 (constrained baseline, offered as
   * `profile-level-id=42e01f` with `level-asymmetry-allowed=1` as libwebrtc
   * and LiveKit offer it, sent at the level each frame size needs, 4.0 at
   * 1920x1080 and 30 fps); VP8 is offered second either way.
   */
  videoCodec?: VideoCodec;
  videoEncoding?: VideoEncoding;
}

export type VideoFrameEvent = {
  frame: VideoFrame;
  timestampUs: bigint;
  rotation: VideoRotation;
};

/** Counters for the published video track; timestamps are epoch ms. */
export interface RelayVideoSenderStats {
  /** Negotiated send codec, learned from the answer; undefined before it. */
  codec: "h264" | "vp8" | undefined;
  framesCaptured: number;
  framesEncoded: number;
  /** Captured while unpublished, before the codec was known, or while the encoder was behind. */
  framesDropped: number;
  keyframes: number;
  rtpPackets: number;
  bytes: number;
  /** PLI and FIR received from the SFU. */
  keyframeRequests: number;
  encodeErrors: number;
  firstFrameAt: number | undefined;
  lastFrameAt: number | undefined;
  /** Frames encoded in the last 5 s. */
  recentFrames: number;
  width: number | undefined;
  height: number | undefined;
}

/** Counters for the other participant's video track; timestamps are epoch ms. */
export interface RelayVideoReceiverStats {
  codec: string | undefined;
  rtpPackets: number;
  /** Whole frames assembled from RTP. */
  framesAssembled: number;
  /** Frames dropped because a packet was lost or malformed, or a delta arrived before a keyframe. */
  framesDropped: number;
  framesDecoded: number;
  decodeErrors: number;
  /** PLI sent to ask the sender for a keyframe. */
  keyframeRequests: number;
  firstFrameAt: number | undefined;
  lastFrameAt: number | undefined;
  /** Frames decoded in the last 5 s. */
  recentFrames: number;
  width: number | undefined;
  height: number | undefined;
}

/** @internal An engine's encoder and RTP writer for the one local video track. */
export interface RelayVideoSenderLike {
  /** The engine track, reused by every peer connection of the call. */
  readonly track: RelayMediaStreamTrackLike;
  /** A new peer added `track`; bind before its offer is created. */
  bind(transceiver: unknown, peer: unknown): void;
  capture(frame: VideoFrame, timestampUs: bigint, rotation: VideoRotation): void;
  setEnabled(enabled: boolean): void;
  stats(): RelayVideoSenderStats;
  close(): void;
}

/** @internal An engine's RTP reader and decoder for one pulled video track. */
export interface RelayVideoReceiverLike {
  onframe: ((event: VideoFrameEvent) => void) | null;
  /** Decode only while a `VideoStream` reads; `true` also asks the sender for a keyframe. */
  setActive(active: boolean): void;
  stats(): RelayVideoReceiverStats;
  stop(): void;
}

/** @internal */
export interface RelayVideoFactory {
  createVideoSender(options: TrackPublishOptions): Promise<RelayVideoSenderLike>;
  createVideoReceiver(track: RelayMediaStreamTrackLike, transceiver: unknown): RelayVideoReceiverLike;
}

type FrameSink = (frame: VideoFrame, timestampUs: bigint, rotation: VideoRotation) => void;

export class VideoSource {
  width: number;
  height: number;
  /** @internal */
  closed = false;
  readonly #sinks = new Set<FrameSink>();

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }

  /**
   * Hand one raw frame to the published track. RGBA, BGRA and I420 (LiveKit
   * `VideoBufferType`) go to the encoder as they are; the other packed RGB
   * layouts are converted to I420 first. `timestampUs` 0 means "now".
   * Frames captured while the track is not published are dropped.
   */
  captureFrame(frame: VideoFrame, timestampUs = BigInt(0), rotation = VideoRotation.VIDEO_ROTATION_0): void {
    if (this.closed) throw new Error("VideoSource is closed");
    for (const sink of this.#sinks) sink(frame, timestampUs, rotation);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.#sinks.clear();
  }

  /** @internal */
  _attach(sink: FrameSink): () => void {
    this.#sinks.add(sink);
    return () => this.#sinks.delete(sink);
  }
}

export class LocalVideoTrack {
  readonly kind = "video" as const;
  readonly name: string;
  /** @internal */
  readonly source: VideoSource;

  constructor(name: string, source: VideoSource) {
    this.name = name;
    this.source = source;
  }

  static createVideoTrack(name: string, source: VideoSource): LocalVideoTrack {
    return new LocalVideoTrack(name, source);
  }

  async close(closeSource = true): Promise<void> {
    if (closeSource) await this.source.close();
  }
}

interface StreamConsumer {
  push(event: VideoFrameEvent): void;
  end(): void;
}

/**
 * The other participant's camera. Emitted once per call by the transport's
 * `trackSubscribed` event; it survives SFU restarts (the transport moves it
 * onto the new session's receiver), so a `VideoStream` read from it keeps going.
 */
export class RemoteVideoTrack {
  readonly kind = "video" as const;
  readonly name = "video";
  #receiver: RelayVideoReceiverLike | undefined;
  #retired: RelayVideoReceiverStats | undefined;
  readonly #consumers = new Set<StreamConsumer>();
  #ended = false;

  /** Counters summed over every receiver this track has had. */
  stats(): RelayVideoReceiverStats | undefined {
    const current = this.#receiver?.stats();
    const retired = this.#retired;
    if (!retired) return current;
    if (!current) return { ...retired, recentFrames: 0 };
    return {
      ...current,
      rtpPackets: retired.rtpPackets + current.rtpPackets,
      framesAssembled: retired.framesAssembled + current.framesAssembled,
      framesDropped: retired.framesDropped + current.framesDropped,
      framesDecoded: retired.framesDecoded + current.framesDecoded,
      decodeErrors: retired.decodeErrors + current.decodeErrors,
      keyframeRequests: retired.keyframeRequests + current.keyframeRequests,
      firstFrameAt: retired.firstFrameAt ?? current.firstFrameAt,
      lastFrameAt: current.lastFrameAt ?? retired.lastFrameAt,
    };
  }

  /** @internal The transport moves the track onto a new session's receiver. */
  _attach(receiver: RelayVideoReceiverLike): void {
    this._detach();
    this.#receiver = receiver;
    receiver.onframe = (event) => {
      for (const consumer of this.#consumers) consumer.push(event);
    };
    receiver.setActive(this.#consumers.size > 0);
  }

  /** @internal */
  _detach(): void {
    const receiver = this.#receiver;
    if (!receiver) return;
    this.#receiver = undefined;
    const stats = receiver.stats();
    const retired = this.#retired;
    this.#retired = retired
      ? {
        ...stats,
        rtpPackets: retired.rtpPackets + stats.rtpPackets,
        framesAssembled: retired.framesAssembled + stats.framesAssembled,
        framesDropped: retired.framesDropped + stats.framesDropped,
        framesDecoded: retired.framesDecoded + stats.framesDecoded,
        decodeErrors: retired.decodeErrors + stats.decodeErrors,
        keyframeRequests: retired.keyframeRequests + stats.keyframeRequests,
        firstFrameAt: retired.firstFrameAt ?? stats.firstFrameAt,
        lastFrameAt: stats.lastFrameAt ?? retired.lastFrameAt,
      }
      : stats;
    receiver.onframe = null;
    receiver.stop();
  }

  /** @internal The call is over: every `VideoStream` ends. */
  _end(): void {
    this._detach();
    this.#ended = true;
    for (const consumer of [...this.#consumers]) consumer.end();
    this.#consumers.clear();
  }

  /** @internal */
  _subscribe(consumer: StreamConsumer): () => void {
    if (this.#ended) {
      consumer.end();
      return () => undefined;
    }
    this.#consumers.add(consumer);
    if (this.#consumers.size === 1) this.#receiver?.setActive(true);
    return () => {
      this.#consumers.delete(consumer);
      if (this.#consumers.size === 0) this.#receiver?.setActive(false);
    };
  }
}

export interface VideoStreamOptions {
  /** Frames kept for a slow reader; 0 (the default) keeps all, a positive number drops the oldest. */
  capacity?: number;
  /** Pixel layout of every frame read; defaults to the decoder's I420. */
  format?: VideoBufferType;
}

/**
 * Decoded frames of a remote video track. Decoding starts when the first
 * stream opens and stops when the last one is cancelled.
 */
export class VideoStream extends ReadableStream<VideoFrameEvent> {
  constructor(track: RemoteVideoTrack, options: VideoStreamOptions = {}) {
    const capacity = options.capacity ?? 0;
    const format = options.format;
    const queue: VideoFrameEvent[] = [];
    let waiting: ((value: void) => void) | undefined;
    let ended = false;
    let unsubscribe: (() => void) | undefined;
    const wake = (): void => {
      const resolve = waiting;
      waiting = undefined;
      resolve?.();
    };
    super({
      start: () => {
        unsubscribe = track._subscribe({
          push: (event) => {
            if (capacity > 0 && queue.length >= capacity) queue.shift();
            queue.push(event);
            wake();
          },
          end: () => {
            ended = true;
            wake();
          },
        });
      },
      pull: async (controller) => {
        while (queue.length === 0 && !ended) await new Promise<void>((resolve) => { waiting = resolve; });
        const event = queue.shift();
        if (!event) {
          controller.close();
          return;
        }
        const frame = format === undefined || format === event.frame.type ? event.frame : event.frame.convert(format);
        controller.enqueue({ ...event, frame });
      },
      cancel: () => {
        unsubscribe?.();
        ended = true;
        wake();
      },
    }, { highWaterMark: 0 });
  }
}
