import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { MediaStreamTrack, RtpPacket } from "werift";
import { createWeriftVideoFactory, loadWebCodecs } from "../../src/calls/engine-werift-video.js";
import { createVideoPacketizer } from "../../src/calls/video-rtp.js";
import type { RelayMediaStreamTrackLike } from "../../src/calls/transport.js";
import { MISSING_WEBCODECS, WEBCODECS_NATIVE } from "./webcodecs-presence.js";

// Every case below decodes real H264/VP8 through node-webcodecs.
it.skipIf(WEBCODECS_NATIVE)("names the missing optional dependency where node-webcodecs does not load", async () => {
  await expect(loadWebCodecs()).rejects.toThrow(MISSING_WEBCODECS);
});

for (const [name, codec] of [["full-range", "h264"], ["limited-range", "h264"], ["vp8", "vp8"]] as const) {
  it.runIf(WEBCODECS_NATIVE)(`factory receiver preserves ${name} decoded planes`, async () => {
    await loadWebCodecs();
    const track = new MediaStreamTrack({ kind: "video" });
    const receiver = createWeriftVideoFactory().createVideoReceiver!(track as unknown as RelayMediaStreamTrackLike, {
      codecs: [{ payloadType: 96, mimeType: codec === "h264" ? "video/H264" : "video/VP8" }],
    });
    const frames: Uint8Array[] = [];
    receiver.onframe = (event) => { frames.push(event.frame.data); };
    receiver.setActive(true);
    try {
      await new Promise((resolve) => setTimeout(resolve, 10));
      const bytes = readFileSync(new URL(`./fixtures/${name}.${codec}`, import.meta.url));
      const packetizer = createVideoPacketizer(codec, { ssrc: 1, payloadType: 96 });
      for (let i = 0; i < 3; i++) {
        for (const packet of packetizer.packetize(bytes, i * 100_000, true)) {
          track.onReceiveRtp.execute(RtpPacket.deSerialize(packet));
        }
      }
      await expect.poll(() => frames.length).toBeGreaterThan(0);
      const expected = readFileSync(new URL(`./fixtures/${name}.yuv`, import.meta.url));
      expect(Buffer.from(frames[0]!)).toEqual(expected);
      expect(receiver.stats().decodeErrors).toBe(0);
    } finally {
      receiver.stop();
      track.stop();
    }
  });
}

it.runIf(WEBCODECS_NATIVE)("counts invalid copy layouts as decode errors and closes every output", async () => {
  const wc = await loadWebCodecs();
  const copy = vi.spyOn(wc.VideoFrame.prototype, "copyTo").mockResolvedValue([]);
  const close = vi.spyOn(wc.VideoFrame.prototype, "close");
  const track = new MediaStreamTrack({ kind: "video" });
  const receiver = createWeriftVideoFactory().createVideoReceiver!(track as unknown as RelayMediaStreamTrackLike, {
    codecs: [{ payloadType: 96, mimeType: "video/H264" }],
  });
  const emit = vi.fn();
  receiver.onframe = emit;
  receiver.setActive(true);
  try {
    await new Promise((resolve) => setTimeout(resolve, 10));
    const bytes = readFileSync(new URL("./fixtures/limited-range.h264", import.meta.url));
    const packetizer = createVideoPacketizer("h264", { ssrc: 1, payloadType: 96 });
    for (let i = 0; i < 3; i++) {
      for (const packet of packetizer.packetize(bytes, i * 100_000, true)) {
        track.onReceiveRtp.execute(RtpPacket.deSerialize(packet));
      }
    }
    await expect.poll(() => receiver.stats().decodeErrors).toBeGreaterThanOrEqual(2);
    expect(receiver.stats().framesDecoded).toBe(0);
    expect(emit).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(copy.mock.calls.length);
    expect(receiver.stats().decodeErrors).toBe(copy.mock.calls.length);
  } finally {
    receiver.stop();
    track.stop();
    copy.mockRestore();
    close.mockRestore();
  }
});

it.runIf(WEBCODECS_NATIVE)("rejects an actual 10-bit H264 frame masked as public I420", async () => {
  const wc = await loadWebCodecs();
  const { copyDecodedI420 } = await import("../../src/calls/video-frame-copy.js");
  const outputs: InstanceType<typeof wc.VideoFrame>[] = [];
  const errors: unknown[] = [];
  const decoder = new wc.VideoDecoder({ output: (frame) => outputs.push(frame), error: (error) => errors.push(error) });
  decoder.configure({ codec: "avc1.6e001f", hardwareAcceleration: "prefer-software" });
  try {
    decoder.decode(new wc.EncodedVideoChunk({ type: "key", timestamp: 0,
      data: readFileSync(new URL("./fixtures/masked-10bit.h264", import.meta.url)) }));
    await decoder.flush();
    expect(errors).toEqual([]);
    expect(outputs).toHaveLength(1);
    const frame = outputs[0]!;
    expect(frame.format).toBe("I420"); // Misleading 1.3.0 public fallback.
    expect(frame._getNative().format).toBe("");
    expect(frame.allocationSize()).toBe(64 * 48 * 1.5);
    expect(frame._getNative().allocationSize()).toBe(64 * 48 * 3);
    const copy = vi.spyOn(frame, "copyTo");
    await expect(copyDecodedI420(frame)).rejects.toThrow("Unverified");
    // Even a stale/permissive input proof cannot bypass the native byte-count check.
    await expect(copyDecodedI420(frame, true)).rejects.toThrow("Unverified");
    expect(copy).not.toHaveBeenCalled();
  } finally {
    for (const frame of outputs) frame.close();
    decoder.close();
  }
});
