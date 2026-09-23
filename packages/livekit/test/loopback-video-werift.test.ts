import { expect, it } from "vitest";
import type { RelayMediaStreamTrackLike, RelayPeerConnectionLike } from "../src/transport.js";
import { createWeriftWebRTCFactory } from "../src/engine-werift.js";
import {
  RemoteVideoTrack,
  VideoBufferType,
  VideoCodec,
  VideoFrame,
  VideoStream,
  type VideoFrameEvent,
} from "../src/video.js";

/**
 * Real loopback: two werift peer connections on this machine, offer/answer
 * wired by hand. A encodes solid-colour RGBA frames (node-webcodecs static
 * build) and sends RTP; B depacketizes, decodes and reads the frames through
 * `VideoStream` in RGBA. No Relay room, no SFU.
 */

const WIDTH = 320;
const HEIGHT = 240;
const FPS = 15;
const PALETTE: Array<[string, [number, number, number]]> = [
  ["red", [220, 40, 40]],
  ["green", [40, 200, 60]],
  ["blue", [40, 60, 220]],
];

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
      if (peer.connectionState === "connected") {
        clearTimeout(timer);
        resolve();
      }
    };
  });

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const solid = ([r, g, b]: [number, number, number]): VideoFrame => {
  const data = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let i = 0; i < WIDTH * HEIGHT; i += 1) data.set([r, g, b, 255], i * 4);
  return new VideoFrame(data, WIDTH, HEIGHT, VideoBufferType.RGBA);
};

/** Nearest palette colour of the centre pixel, or undefined when none is within 40 per channel. */
const colourOf = (frame: VideoFrame): string | undefined => {
  const at = ((HEIGHT >> 1) * WIDTH + (WIDTH >> 1)) * 4;
  const pixel = [frame.data[at]!, frame.data[at + 1]!, frame.data[at + 2]!];
  const match = PALETTE.find(([, rgb]) => rgb.every((value, i) => Math.abs(value - pixel[i]!) <= 40));
  return match?.[0];
};

const loopback = async (videoCodec: VideoCodec) => {
  const factory = createWeriftWebRTCFactory();
  const a = factory.createPeerConnection();
  const b = factory.createPeerConnection();
  const sender = await factory.createVideoSender!({ videoCodec });
  const transceiver = a.addTransceiver(sender.track, { direction: "sendonly" });
  sender.bind(transceiver, a);
  const remote = new Promise<{ track: RelayMediaStreamTrackLike; transceiver: unknown }>((resolve) => {
    b.ontrack = (event) => resolve({ track: event.track, transceiver: event.transceiver });
  });
  const connected = Promise.all([waitForConnected(a), waitForConnected(b)]);
  await a.setLocalDescription(await a.createOffer());
  await waitForIce(a);
  await b.setRemoteDescription({ type: "offer", sdp: a.localDescription!.sdp });
  await b.setLocalDescription(await b.createAnswer());
  await waitForIce(b);
  await a.setRemoteDescription({ type: "answer", sdp: b.localDescription!.sdp });
  await connected;

  const pulled = await remote;
  const track = new RemoteVideoTrack();
  track._attach(factory.createVideoReceiver!(pulled.track, pulled.transceiver));
  const stream = new VideoStream(track, { format: VideoBufferType.RGBA });
  const seen: Array<{ colour: string | undefined; event: VideoFrameEvent }> = [];
  const reading = (async () => {
    for await (const event of stream) seen.push({ colour: colourOf(event.frame), event });
  })();

  const sent: string[] = [];
  const started = Date.now();
  for (let i = 0; i < FPS * PALETTE.length; i += 1) {
    const [name, rgb] = PALETTE[Math.floor(i / FPS)]!;
    sender.capture(solid(rgb), BigInt(0), 0);
    sent.push(name);
    await sleep(started + ((i + 1) * 1000) / FPS - Date.now());
  }
  await sleep(500);
  const senderStats = sender.stats();
  const receiverStats = track.stats();
  track._end();
  await reading;
  sender.close();
  a.close();
  b.close();
  return { seen, senderStats, receiverStats };
};

for (const [label, codec, mime] of [["H.264", VideoCodec.H264, "video/H264"], ["VP8", VideoCodec.VP8, "video/VP8"]] as const) {
  it(`carries a colour that changes each second from A to B over werift + ${label}`, async () => {
    const { seen, senderStats, receiverStats } = await loopback(codec);
    if (process.env.VIDEO_LOOPBACK_LOG) {
      console.log(label, JSON.stringify({ decoded: seen.length, sender: senderStats, receiver: receiverStats }));
    }
    expect(senderStats.codec).toBe(codec === VideoCodec.H264 ? "h264" : "vp8");
    expect(receiverStats?.codec).toBe(mime);
    expect(receiverStats?.decodeErrors).toBe(0);
    expect(seen.every((entry) => entry.event.frame.width === WIDTH && entry.event.frame.height === HEIGHT)).toBe(true);
    // Every decoded frame is one of the palette colours, in the order sent, and all three arrive.
    const colours = seen.map((entry) => entry.colour);
    expect(colours.every((colour) => colour !== undefined)).toBe(true);
    const order = colours.filter((colour, i) => colour !== colours[i - 1]);
    expect(order).toEqual(["red", "green", "blue"]);
    // Most frames arrive: the first ones wait for the keyframe the receiver's PLI asks for.
    expect(seen.length).toBeGreaterThanOrEqual(FPS * PALETTE.length * 0.6);
  }, 30_000);
}
