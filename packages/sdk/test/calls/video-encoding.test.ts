import { writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import type { RelayMediaStreamTrackLike, RelayPeerConnectionLike } from "../../src/calls/transport.js";
import { createWeriftWebRTCFactory } from "../../src/calls/engine-werift.js";
import { H264_ENCODER_CODEC, WeriftVideoSender } from "../../src/calls/engine-werift-video.js";
import { defaultVideoEncoding } from "../../src/calls/video-presets.js";
import {
  RemoteVideoTrack,
  VideoBufferType,
  VideoCodec,
  VideoFrame,
  VideoStream,
  type TrackPublishOptions,
} from "../../src/calls/video.js";

/**
 * The encoding a published camera gets: LiveKit's camera preset for the
 * frame size when the caller passes no `videoEncoding`
 * (livekit/client-sdk-js src/room/track/options.ts:507-532 and
 * src/room/participant/publishUtils.ts:310-368 at 5cadc938), and H.264 sent
 * at level 4.0 at 1920x1080 while the offer keeps libwebrtc's
 * `profile-level-id=42e01f`.
 */

const VIDEO_BUILD = new Set(["darwin-arm64", "linux-x64", "linux-arm64"]).has(`${process.platform}-${process.arch}`);

it("picks LiveKit's camera preset for the frame size", () => {
  // VideoPresets (16:9): h1080, h720, h540, h360, h180.
  expect(defaultVideoEncoding(1920, 1080)).toEqual({ maxBitrate: 3_000_000, maxFramerate: 30 });
  expect(defaultVideoEncoding(1280, 720)).toEqual({ maxBitrate: 1_700_000, maxFramerate: 30 });
  expect(defaultVideoEncoding(960, 540)).toEqual({ maxBitrate: 800_000, maxFramerate: 25 });
  expect(defaultVideoEncoding(640, 360)).toEqual({ maxBitrate: 450_000, maxFramerate: 20 });
  expect(defaultVideoEncoding(320, 180)).toEqual({ maxBitrate: 160_000, maxFramerate: 20 });
  // Portrait uses the longer side; a size between presets takes the next one up.
  expect(defaultVideoEncoding(1080, 1920)).toEqual({ maxBitrate: 3_000_000, maxFramerate: 30 });
  expect(defaultVideoEncoding(1000, 562)).toEqual({ maxBitrate: 1_700_000, maxFramerate: 30 });
  // VideoPresets43 (4:3): h480, h1080.
  expect(defaultVideoEncoding(640, 480)).toEqual({ maxBitrate: 500_000, maxFramerate: 20 });
  expect(defaultVideoEncoding(1440, 1080)).toEqual({ maxBitrate: 2_300_000, maxFramerate: 30 });
  // Past the largest preset, the largest.
  expect(defaultVideoEncoding(7680, 4320)).toEqual({ maxBitrate: 8_000_000, maxFramerate: 30 });
});

/** A WebCodecs stand-in that records each encoder configuration. */
const recordingWebCodecs = () => {
  const configs: Array<Record<string, unknown>> = [];
  class VideoEncoder {
    state = "unconfigured";
    encodeQueueSize = 0;
    configure(config: Record<string, unknown>): void {
      configs.push(config);
      this.state = "configured";
    }
    encode(): void {}
    close(): void {
      this.state = "closed";
    }
  }
  class FakeFrame {
    close(): void {}
  }
  return { configs, wc: { VideoEncoder, VideoFrame: FakeFrame } };
};

/** The sender bound to a transceiver whose negotiated send codec is `mimeType`. */
const boundSender = (mimeType: string, options: TrackPublishOptions = {}) => {
  const { configs, wc } = recordingWebCodecs();
  const sender = new WeriftVideoSender(wc as never, options);
  const subscription = { subscribe: () => ({ unSubscribe: () => undefined }) };
  sender.bind(
    { codecs: [], sender: { codec: { mimeType }, onPictureLossIndication: subscription, onRtcp: subscription } },
    { config: { codecs: { video: [] } } },
  );
  const send = (width: number, height: number): void =>
    sender.capture(new VideoFrame(new Uint8Array((width * height * 3) / 2), width, height, VideoBufferType.I420), BigInt(0), 0);
  return { configs, send, sender };
};

const encoderSettings = (config: Record<string, unknown>) =>
  ({ codec: config.codec, width: config.width, height: config.height, bitrate: config.bitrate, framerate: config.framerate });

it("configures H.264 at level 4.0 with the preset for each frame size sent", () => {
  const { configs, send, sender } = boundSender("video/H264");
  send(1920, 1080);
  send(1280, 720);
  send(640, 360);
  sender.close();
  expect(H264_ENCODER_CODEC).toBe("avc1.42e028");
  expect(configs.map(encoderSettings)).toEqual([
    { codec: "avc1.42e028", width: 1920, height: 1080, bitrate: 3_000_000, framerate: 30 },
    { codec: "avc1.42e028", width: 1280, height: 720, bitrate: 1_700_000, framerate: 30 },
    { codec: "avc1.42e028", width: 640, height: 360, bitrate: 450_000, framerate: 20 },
  ]);
});

it("configures VP8 with the same presets", () => {
  const { configs, send, sender } = boundSender("video/VP8", { videoCodec: VideoCodec.VP8 });
  send(1920, 1080);
  send(640, 360);
  sender.close();
  expect(configs.map(encoderSettings)).toEqual([
    { codec: "vp8", width: 1920, height: 1080, bitrate: 3_000_000, framerate: 30 },
    { codec: "vp8", width: 640, height: 360, bitrate: 450_000, framerate: 20 },
  ]);
});

it("lets each videoEncoding field the caller sets win over the preset", () => {
  const both = boundSender("video/H264", { videoEncoding: { maxBitrate: BigInt(2_000_000), maxFramerate: 15 } });
  both.send(1920, 1080);
  both.sender.close();
  const rateOnly = boundSender("video/H264", { videoEncoding: { maxBitrate: 1_000_000 } });
  rateOnly.send(1920, 1080);
  rateOnly.sender.close();
  expect([...both.configs, ...rateOnly.configs].map(encoderSettings)).toEqual([
    { codec: "avc1.42e028", width: 1920, height: 1080, bitrate: 2_000_000, framerate: 15 },
    { codec: "avc1.42e028", width: 1920, height: 1080, bitrate: 1_000_000, framerate: 30 },
  ]);
});

const waitForIce = (peer: RelayPeerConnectionLike): Promise<void> =>
  new Promise((resolve) => {
    if (peer.iceGatheringState === "complete") return resolve();
    const changed = (): void => {
      if (peer.iceGatheringState !== "complete") return;
      peer.removeEventListener("icegatheringstatechange", changed);
      resolve();
    };
    peer.addEventListener("icegatheringstatechange", changed);
  });

const waitForConnected = (peer: RelayPeerConnectionLike): Promise<void> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`peer stuck in ${peer.connectionState}`)), 10_000);
    peer.onconnectionstatechange = () => {
      if (peer.connectionState !== "connected") return;
      clearTimeout(timer);
      resolve();
    };
  });

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The H.264 SPS NAL units in one RTP payload: a single NAL unit or a STAP-A (RFC 6184 sections 5.6-5.7). */
const spsUnits = (payload: Buffer): Buffer[] => {
  const type = payload[0]! & 0x1f;
  if (type === 7) return [payload];
  if (type !== 24) return [];
  const units: Buffer[] = [];
  for (let at = 1; at + 2 <= payload.length;) {
    const size = payload.readUInt16BE(at);
    const unit = payload.subarray(at + 2, at + 2 + size);
    if ((unit[0]! & 0x1f) === 7) units.push(unit);
    at += 2 + size;
  }
  return units;
};

const fmtpOf = (sdp: string): string | undefined => /a=fmtp:\d+ (\S*profile-level-id=\S+)/u.exec(sdp)?.[1];

it.runIf(VIDEO_BUILD)("sends 1920x1080 H.264 at level 4.0 over werift, offered as 42e01f, and decodes it", async () => {
  const WIDTH = 1920;
  const HEIGHT = 1080;
  const factory = createWeriftWebRTCFactory();
  const a = factory.createPeerConnection();
  const b = factory.createPeerConnection();
  const sender = await factory.createVideoSender!({ videoCodec: VideoCodec.H264 });
  sender.bind(a.addTransceiver(sender.track, { direction: "sendonly" }), a);
  const remote = new Promise<{ track: RelayMediaStreamTrackLike; transceiver: unknown }>((resolve) => {
    b.ontrack = (event) => resolve({ track: event.track, transceiver: event.transceiver });
  });
  const connected = Promise.all([waitForConnected(a), waitForConnected(b)]);
  await a.setLocalDescription(await a.createOffer());
  await waitForIce(a);
  const offer = a.localDescription!.sdp;
  await b.setRemoteDescription({ type: "offer", sdp: offer });
  await b.setLocalDescription(await b.createAnswer());
  await waitForIce(b);
  await a.setRemoteDescription({ type: "answer", sdp: b.localDescription!.sdp });
  await connected;

  const pulled = await remote;
  const levels = new Set<string>();
  const rtpTrack = pulled.track as unknown as {
    onReceiveRtp: { subscribe: (fn: (rtp: { payload: Buffer }) => void) => { unSubscribe: () => void } };
  };
  const tap = rtpTrack.onReceiveRtp.subscribe((rtp) => {
    for (const sps of spsUnits(rtp.payload)) levels.add(sps.subarray(1, 4).toString("hex"));
  });
  const track = new RemoteVideoTrack();
  track._attach(factory.createVideoReceiver!(pulled.track, pulled.transceiver));
  const stream = new VideoStream(track);
  const sizes = new Set<string>();
  let decoded = 0;
  const reading = (async () => {
    for await (const event of stream) {
      decoded += 1;
      sizes.add(`${event.frame.width}x${event.frame.height}`);
    }
  })();

  const frame = new Uint8Array((WIDTH * HEIGHT * 3) / 2).fill(128);
  const started = Date.now();
  for (let i = 0; i < 60; i += 1) {
    frame.fill((i * 4) % 256, 0, WIDTH * HEIGHT);
    sender.capture(new VideoFrame(frame, WIDTH, HEIGHT, VideoBufferType.I420), BigInt(0), 0);
    await sleep(started + ((i + 1) * 1000) / 30 - Date.now());
  }
  await sleep(500);
  const senderStats = sender.stats();
  const receiverStats = track.stats();
  tap.unSubscribe();
  track._end();
  await reading;
  sender.close();
  a.close();
  b.close();
  // VIDEO_ENCODING_RECEIPT=<file> keeps what was on the wire, for a PR receipt.
  const receipt = process.env.VIDEO_ENCODING_RECEIPT;
  if (receipt) {
    writeFileSync(receipt, JSON.stringify({ fmtp: fmtpOf(offer), sps: [...levels], decoded, sizes: [...sizes], senderStats, receiverStats }));
  }

  // The offer keeps libwebrtc's constrained baseline level 3.1 with level asymmetry.
  expect(fmtpOf(offer)).toBe("level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f");
  // Every SPS on the wire: profile_idc 66, constraint_set0 and set1, level_idc 40.
  expect([...levels]).toEqual(["42c028"]);
  expect(senderStats).toMatchObject({ codec: "h264", width: WIDTH, height: HEIGHT, encodeErrors: 0 });
  expect(receiverStats?.decodeErrors).toBe(0);
  expect([...sizes]).toEqual([`${WIDTH}x${HEIGHT}`]);
  expect(decoded).toBeGreaterThanOrEqual(30);
}, 60_000);
