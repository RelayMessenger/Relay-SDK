/**
 * Video in LiveKit's own Node shapes, carried by `@relaymessenger/sdk/calls`.
 *
 * Twin of the Python package's `relaymessenger_livekit/video.py`. Frames are
 * `@livekit/rtc-node` `VideoFrame`s both ways, so a frame read here can go
 * straight into an `llm.ImageContent` or a realtime model's `pushVideo`, and a
 * frame an application already makes for LiveKit can be sent unchanged. The
 * names copy `@livekit/rtc-node`: `VideoSource.captureFrame(frame,
 * timestampUs, rotation)`, `LocalVideoTrack.createVideoTrack(name, source)`,
 * `new VideoStream(track)` yielding `VideoFrameEvent`. The media itself lives
 * in `@relaymessenger/sdk/calls`; this module converts at its two edges.
 */
import { ReadableStream } from "node:stream/web";
import {
  VideoBufferType as RtcVideoBufferType,
  VideoFrame as RtcVideoFrame,
  type VideoFrameEvent as RtcVideoFrameEvent,
} from "@livekit/rtc-node";
import {
  VideoBufferType,
  VideoFrame,
  VideoRotation,
  VideoSource as RelayVideoSource,
  VideoStream as RelayVideoStream,
  type RemoteVideoTrack,
  type VideoStreamOptions,
} from "@relaymessenger/sdk/calls";

export {
  LocalVideoTrack,
  RemoteVideoTrack,
  VideoCodec,
  type RelayVideoReceiverStats,
  type RelayVideoSenderStats,
  type TrackPublishOptions,
  type VideoEncoding,
  type VideoStreamOptions,
} from "@relaymessenger/sdk/calls";

/** Layouts the Relay encoder takes as they are, or converts itself (video.ts `captureFrame`). */
const RELAY_LAYOUTS = new Set<number>([
  VideoBufferType.RGBA,
  VideoBufferType.ABGR,
  VideoBufferType.ARGB,
  VideoBufferType.BGRA,
  VideoBufferType.RGB24,
  VideoBufferType.I420,
]);

/**
 * A LiveKit frame as a Relay frame, sharing its bytes. `VideoBufferType` has
 * the same numbers on both sides; any layout the Relay encoder does not take
 * (NV12, I420A, I422, I444, I010) goes through LiveKit's own converter to I420
 * first, as the Python twin does.
 */
export const toRelayFrame = (frame: RtcVideoFrame): VideoFrame => {
  const source = RELAY_LAYOUTS.has(frame.type) ? frame : frame.convert(RtcVideoBufferType.I420);
  return new VideoFrame(source.data, source.width, source.height, source.type as number as VideoBufferType);
};

/** A Relay frame (the decoder's I420 by default) as a LiveKit frame, sharing its bytes. */
export const toRtcFrame = (frame: VideoFrame): RtcVideoFrame =>
  new RtcVideoFrame(frame.data, frame.width, frame.height, frame.type as number as RtcVideoBufferType);

/** The camera feed the agent sends (LiveKit `VideoSource`), taking `@livekit/rtc-node` frames. */
export class VideoSource extends RelayVideoSource {
  /**
   * Queue `frame` for the next encode; a newer frame replaces one not yet
   * taken, as a live camera does. Frames captured while the track is not
   * published are dropped.
   */
  override captureFrame(
    frame: RtcVideoFrame | VideoFrame,
    timestampUs = BigInt(0),
    rotation: VideoRotation = VideoRotation.VIDEO_ROTATION_0,
  ): void {
    super.captureFrame(frame instanceof RtcVideoFrame ? toRelayFrame(frame) : frame, timestampUs, rotation);
  }
}

/** LiveKit's `VideoStream`: the remote track's decoded frames as `@livekit/rtc-node` events. */
export class VideoStream extends ReadableStream<RtcVideoFrameEvent> {
  constructor(track: RemoteVideoTrack, options: VideoStreamOptions = {}) {
    const relay = new RelayVideoStream(track, options);
    const reader = relay.getReader();
    super({
      pull: async (controller) => {
        const { done, value } = await reader.read();
        if (done) {
          try { controller.close(); } catch { /* cancelled while reading */ }
          return;
        }
        controller.enqueue({
          frame: toRtcFrame(value.frame),
          timestampUs: value.timestampUs,
          rotation: value.rotation as number as RtcVideoFrameEvent["rotation"],
        });
      },
      cancel: async () => {
        await reader.cancel();
      },
    }, { highWaterMark: 0 });
  }
}
