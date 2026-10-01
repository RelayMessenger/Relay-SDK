import { expect, it } from "vitest";
import { VideoBufferType as RtcVideoBufferType, VideoFrame as RtcVideoFrame } from "@livekit/rtc-node";
import {
  RemoteVideoTrack,
  VideoBufferType,
  VideoFrame,
  VideoRotation,
  type RelayCallTransport,
  type VideoFrameEvent,
} from "@relaymessenger/sdk/calls";
import { RelayVideoInput } from "../src/livekit.js";
import { VideoSource, VideoStream, toRelayFrame, toRtcFrame } from "../src/video.js";

/** A receiver the test drives: `emit` is one decoded frame off the wire. */
class FakeReceiver {
  onframe: ((event: VideoFrameEvent) => void) | null = null;
  active = false;
  setActive(active: boolean): void { this.active = active; }
  stats() {
    return { rtpPackets: 0, framesAssembled: 0, framesDropped: 0, framesDecoded: 0, decodeErrors: 0,
      keyframeRequests: 0, recentFrames: 0, firstFrameAt: undefined, lastFrameAt: undefined } as never;
  }
  stop(): void {}
  emit(id: number): void {
    this.onframe?.({ frame: i420(id), timestampUs: BigInt(id), rotation: VideoRotation.VIDEO_ROTATION_0 });
  }
}

/** A 2x2 I420 frame whose every byte is `id`. */
const i420 = (id: number): VideoFrame => new VideoFrame(new Uint8Array(6).fill(id), 2, 2, VideoBufferType.I420);

class FakeTransport {
  readonly listeners = new Set<(track: RemoteVideoTrack) => void>();
  remoteVideoTrack: RemoteVideoTrack | undefined;
  on(event: string, listener: (track: RemoteVideoTrack) => void): this {
    if (event === "trackSubscribed") this.listeners.add(listener);
    return this;
  }
  off(event: string, listener: (track: RemoteVideoTrack) => void): this {
    if (event === "trackSubscribed") this.listeners.delete(listener);
    return this;
  }
  subscribe(track: RemoteVideoTrack): void {
    this.remoteVideoTrack = track;
    for (const listener of this.listeners) listener(track);
  }
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

const remote = (): { track: RemoteVideoTrack; receiver: FakeReceiver } => {
  const track = new RemoteVideoTrack();
  const receiver = new FakeReceiver();
  track._attach(receiver);
  return { track, receiver };
};

it("hands the person's camera to LiveKit as rtc-node I420 frames once the track is subscribed", async () => {
  const transport = new FakeTransport();
  const input = new RelayVideoInput(transport as unknown as RelayCallTransport);
  expect(input.latestFrame).toBeUndefined();
  const { track, receiver } = remote();
  transport.subscribe(track);
  await settle();
  expect(receiver.active).toBe(true);

  const frames = input[Symbol.asyncIterator]();
  const next = frames.next();
  receiver.emit(7);
  const { value } = await next;
  expect(value).toBeInstanceOf(RtcVideoFrame);
  expect(value!.type).toBe(RtcVideoBufferType.I420);
  expect([value!.width, value!.height, [...value!.data]]).toEqual([2, 2, [7, 7, 7, 7, 7, 7]]);
  expect(input.latestFrame).toBe(value);

  await input.close();
  expect(transport.listeners.size).toBe(0);
  expect(receiver.active).toBe(false);
  expect((await frames.next()).done).toBe(true);
});

it("reads a track the transport already had, keeps only the newest unread frame, and drops frames while detached", async () => {
  const transport = new FakeTransport();
  const { track, receiver } = remote();
  transport.remoteVideoTrack = track;
  const input = new RelayVideoInput(transport as unknown as RelayCallTransport);
  await settle();

  receiver.emit(1);
  receiver.emit(2);
  await settle();
  const frames = input[Symbol.asyncIterator]();
  expect((await frames.next()).value!.data[0]).toBe(2);

  input.setAttached(false);
  receiver.emit(3);
  await settle();
  expect(input.latestFrame!.data[0]).toBe(2);
  input.setAttached(true);
  receiver.emit(4);
  expect((await frames.next()).value!.data[0]).toBe(4);
  await input.close();
});

it("sends rtc-node frames through the Relay encoder, converting what it does not take to I420", () => {
  const source = new VideoSource(2, 2);
  const captured: Array<{ frame: VideoFrame; timestampUs: bigint; rotation: VideoRotation }> = [];
  source._attach((frame, timestampUs, rotation) => captured.push({ frame, timestampUs, rotation }));

  const rgba = new RtcVideoFrame(new Uint8Array(16).fill(9), 2, 2, RtcVideoBufferType.RGBA);
  source.captureFrame(rgba, 5n, VideoRotation.VIDEO_ROTATION_90);
  expect(captured[0]!.frame).toBeInstanceOf(VideoFrame);
  expect(captured[0]!.frame.type).toBe(VideoBufferType.RGBA);
  expect(captured[0]!.frame.data).toBe(rgba.data);
  expect([captured[0]!.timestampUs, captured[0]!.rotation]).toEqual([5n, VideoRotation.VIDEO_ROTATION_90]);

  const nv12 = new RtcVideoFrame(new Uint8Array([16, 16, 16, 16, 128, 128]), 2, 2, RtcVideoBufferType.NV12);
  source.captureFrame(nv12);
  expect(captured[1]!.frame.type).toBe(VideoBufferType.I420);
  expect(captured[1]!.frame.data.length).toBe(6);

  const relayFrame = i420(3);
  source.captureFrame(relayFrame);
  expect(captured[2]!.frame).toBe(relayFrame);
});

it("converts frames both ways without copying and reads a remote track as rtc-node events", async () => {
  const relay = i420(5);
  const rtc = toRtcFrame(relay);
  expect(rtc.data).toBe(relay.data);
  expect(toRelayFrame(rtc).data).toBe(relay.data);

  const { track, receiver } = remote();
  const reader = new VideoStream(track).getReader();
  const read = reader.read();
  await settle();
  receiver.emit(6);
  const { value } = await read;
  expect(value!.frame).toBeInstanceOf(RtcVideoFrame);
  expect([value!.timestampUs, value!.rotation]).toEqual([6n, 0]);
  track._end();
  expect((await reader.read()).done).toBe(true);
});
