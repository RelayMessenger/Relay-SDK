import { describe, expect, it } from "vitest";
import {
  type AssembledVideoFrame,
  type VideoRtpPacket,
  VideoFrameAssembler,
  createVideoPacketizer,
  splitAnnexB,
} from "../../src/calls/video-rtp.js";
import { VideoBufferType, VideoFrame } from "../../src/calls/video-frame.js";

/** Parse an RTP buffer from the packetizer into the fields the assembler reads (RFC 3550 section 5.1). */
const parse = (buffer: Buffer): VideoRtpPacket & { payloadType: number } => ({
  sequenceNumber: buffer.readUInt16BE(2),
  timestamp: buffer.readUInt32BE(4),
  marker: (buffer[1]! & 0x80) !== 0,
  payloadType: buffer[1]! & 0x7f,
  payload: buffer.subarray(12),
});

const bytes = (length: number, seed: number): Uint8Array => {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) out[i] = (i * 31 + seed * 7 + 1) & 0xff;
  // No accidental start codes inside a NAL unit.
  for (let i = 2; i < length; i += 1) if (out[i - 2] === 0 && out[i - 1] === 0 && out[i]! <= 3) out[i] = 4;
  return out;
};

const nal = (type: number, length: number, seed: number): Uint8Array => {
  const unit = bytes(length, seed);
  unit[0] = 0x60 | type;
  return unit;
};

const annexB = (units: Uint8Array[]): Uint8Array => {
  const out: number[] = [];
  for (const unit of units) out.push(0, 0, 0, 1, ...unit);
  return Uint8Array.from(out);
};

const collect = (codec: "h264" | "vp8") => {
  const frames: AssembledVideoFrame[] = [];
  const drops: string[] = [];
  const assembler = new VideoFrameAssembler(codec, (frame) => frames.push(frame), (reason) => drops.push(reason));
  return { assembler, frames, drops };
};

/** A VP8 frame whose first byte carries P (bit 0): 0 keyframe, 1 interframe (RFC 7741 section 4.3). */
const vp8Frame = (length: number, keyframe: boolean, seed: number): Uint8Array => {
  const frame = bytes(length, seed);
  frame[0] = keyframe ? 0x10 : 0x11;
  return frame;
};

describe("H.264 packetize and depacketize", () => {
  const sps = nal(7, 12, 1);
  const pps = nal(8, 5, 2);
  const idr = nal(5, 5_000, 3);
  const slice = nal(1, 700, 4);

  it("sends SPS and PPS as one STAP-A and a large IDR as FU-A, and reassembles the access unit byte for byte", () => {
    const packetizer = createVideoPacketizer("h264", { ssrc: 1, payloadType: 96 });
    const { assembler, frames, drops } = collect("h264");
    // A delta frame first establishes the frame boundary, as mid-stream.
    for (const packet of packetizer.packetize(annexB([slice]), 900_000, false).map(parse)) assembler.push(packet);
    const packets = packetizer.packetize(annexB([sps, pps, idr]), 1_000_000, true).map(parse);
    expect(packets[0]!.payload[0]! & 0x1f).toBe(24);
    expect(packets[0]!.marker).toBe(false);
    const fragments = packets.slice(1);
    expect(fragments.length).toBe(Math.ceil((idr.length - 1) / (1_200 - 2)));
    expect(fragments.every((packet) => (packet.payload[0]! & 0x1f) === 28)).toBe(true);
    expect(fragments.at(-1)!.marker).toBe(true);
    expect(new Set(packets.map((packet) => packet.timestamp))).toEqual(new Set([90_000]));

    frames.length = 0;
    drops.length = 0;
    for (const packet of packets) assembler.push(packet);
    expect(drops).toEqual([]);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.keyframe).toBe(true);
    expect(splitAnnexB(frames[0]!.data)).toEqual([sps, pps, idr]);
  });

  it("carries a small single-NAL delta frame and marks it not a keyframe", () => {
    const packetizer = createVideoPacketizer("h264", { ssrc: 1, payloadType: 96 });
    const { assembler, frames } = collect("h264");
    for (const packet of packetizer.packetize(annexB([sps, pps, idr]), 0, true).map(parse)) assembler.push(packet);
    for (const packet of packetizer.packetize(annexB([slice]), 33_333, false).map(parse)) assembler.push(packet);
    // The keyframe opens with SPS, so it is whole even as the stream's first frame.
    expect(frames).toHaveLength(2);
    expect(frames[1]!.keyframe).toBe(false);
    expect(splitAnnexB(frames[1]!.data)).toEqual([slice]);
  });

  it("drops a frame that lost one FU-A fragment and delivers the next whole frame", () => {
    const packetizer = createVideoPacketizer("h264", { ssrc: 1, payloadType: 96 });
    const { assembler, frames, drops } = collect("h264");
    for (const packet of packetizer.packetize(annexB([slice]), 0, false).map(parse)) assembler.push(packet);
    const lossy = packetizer.packetize(annexB([sps, pps, idr]), 33_333, true).map(parse);
    lossy.splice(2, 1);
    for (const packet of lossy) assembler.push(packet);
    const after = packetizer.packetize(annexB([slice]), 66_666, false).map(parse);
    for (const packet of after) assembler.push(packet);
    expect(drops.filter((reason) => reason === "loss").length).toBeGreaterThanOrEqual(1);
    expect(frames.filter((frame) => frame.keyframe)).toHaveLength(0);
    // The frame right after the loss begins with no gap and is whole.
    expect(frames.at(-1) && splitAnnexB(frames.at(-1)!.data)).toEqual([slice]);
  });

  it("drops a frame whose marker packet was lost instead of gluing it to the next frame", () => {
    const packetizer = createVideoPacketizer("h264", { ssrc: 1, payloadType: 96 });
    const { assembler, frames, drops } = collect("h264");
    for (const packet of packetizer.packetize(annexB([slice]), 0, false).map(parse)) assembler.push(packet);
    const idrPackets = packetizer.packetize(annexB([sps, pps, idr]), 33_333, true).map(parse);
    for (const packet of idrPackets.slice(0, -1)) assembler.push(packet);
    const next = packetizer.packetize(annexB([slice]), 66_666, false).map(parse);
    for (const packet of next) assembler.push(packet);
    expect(drops).toContain("loss");
    expect(frames.every((frame) => !frame.keyframe)).toBe(true);
    for (const frame of frames) expect(splitAnnexB(frame.data)).toEqual([slice]);
  });

  it("drops a stream's first frame when it cannot prove where the frame begins", () => {
    const packetizer = createVideoPacketizer("h264", { ssrc: 1, payloadType: 96 });
    const { assembler, frames, drops } = collect("h264");
    for (const packet of packetizer.packetize(annexB([slice]), 0, false).map(parse)) assembler.push(packet);
    expect(frames).toHaveLength(0);
    expect(drops).toEqual(["loss"]);
  });

  it("rejects a malformed STAP-A", () => {
    const { assembler, frames, drops } = collect("h264");
    assembler.push({ sequenceNumber: 1, timestamp: 1, marker: true, payload: Uint8Array.from([0x61]) });
    assembler.push({ sequenceNumber: 2, timestamp: 2, marker: true, payload: Uint8Array.from([0x78, 0, 9, 0x67]) });
    expect(frames).toHaveLength(0);
    expect(drops.at(-1)).toBe("malformed");
  });
});

describe("VP8 packetize and depacketize", () => {
  it("fragments a keyframe with a PictureID descriptor and reassembles it byte for byte", () => {
    const packetizer = createVideoPacketizer("vp8", { ssrc: 1, payloadType: 96 });
    const key = vp8Frame(4_000, true, 5);
    const packets = packetizer.packetize(key, 0, true).map(parse);
    expect(packets.length).toBe(Math.ceil(key.length / (1_200 - 4)));
    expect(packets[0]!.payload[0]! & 0x10).toBe(0x10);
    expect(packets.slice(1).every((packet) => (packet.payload[0]! & 0x10) === 0)).toBe(true);
    const { assembler, frames, drops } = collect("vp8");
    for (const packet of packets) assembler.push(packet);
    expect(drops).toEqual([]);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.keyframe).toBe(true);
    expect(Uint8Array.from(frames[0]!.data)).toEqual(key);
  });

  it("marks an interframe as delta and drops a frame whose first packet was lost", () => {
    const packetizer = createVideoPacketizer("vp8", { ssrc: 1, payloadType: 96 });
    const { assembler, frames, drops } = collect("vp8");
    const delta = vp8Frame(300, false, 6);
    for (const packet of packetizer.packetize(delta, 0, false).map(parse)) assembler.push(packet);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.keyframe).toBe(false);
    expect(Uint8Array.from(frames[0]!.data)).toEqual(delta);
    const big = packetizer.packetize(vp8Frame(3_000, true, 7), 33_333, true).map(parse);
    for (const packet of big.slice(1)) assembler.push(packet);
    expect(frames).toHaveLength(1);
    expect(drops).toEqual(["loss"]);
  });
});

describe("VideoFrame.convert", () => {
  it("round-trips a flat colour RGBA -> I420 -> RGBA within 2 levels (libyuv BT.601)", () => {
    const width = 4;
    const height = 2;
    const rgba = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i += 1) rgba.set([200, 30, 60, 255], i * 4);
    const back = new VideoFrame(rgba, width, height, VideoBufferType.RGBA)
      .convert(VideoBufferType.I420)
      .convert(VideoBufferType.RGBA);
    for (let i = 0; i < width * height; i += 1) {
      expect(Math.abs(back.data[i * 4]! - 200)).toBeLessThanOrEqual(2);
      expect(Math.abs(back.data[i * 4 + 1]! - 30)).toBeLessThanOrEqual(2);
      expect(Math.abs(back.data[i * 4 + 2]! - 60)).toBeLessThanOrEqual(2);
    }
  });
});
