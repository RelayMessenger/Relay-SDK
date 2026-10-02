import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { MediaStreamTrack, RtpPacket } from "werift";
import { createWeriftVideoFactory, loadWebCodecs } from "../../src/calls/engine-werift-video.js";
import { createVideoPacketizer } from "../../src/calls/video-rtp.js";
import type { RelayMediaStreamTrackLike } from "../../src/calls/transport.js";

for (const range of ["full", "limited"]) {
  it(`factory receiver preserves ${range}-range H264 planes`, async () => {
    await loadWebCodecs();
    const track = new MediaStreamTrack({ kind: "video" });
    const receiver = createWeriftVideoFactory().createVideoReceiver!(track as unknown as RelayMediaStreamTrackLike, {
      codecs: [{ payloadType: 96, mimeType: "video/H264" }],
    });
    const frames: Uint8Array[] = [];
    receiver.onframe = (event) => { frames.push(event.frame.data); };
    receiver.setActive(true);
    try {
      await new Promise((resolve) => setTimeout(resolve, 10));
      const bytes = readFileSync(new URL(`./fixtures/${range}-range.h264`, import.meta.url));
      const packetizer = createVideoPacketizer("h264", { ssrc: 1, payloadType: 96 });
      for (let i = 0; i < 3; i++) {
        for (const packet of packetizer.packetize(bytes, i * 100_000, true)) {
          track.onReceiveRtp.execute(RtpPacket.deSerialize(packet));
        }
      }
      await expect.poll(() => frames.length).toBeGreaterThan(0);
      const expected = readFileSync(new URL(`./fixtures/${range}-range.yuv`, import.meta.url));
      expect(Buffer.from(frames[0]!)).toEqual(expected);
      expect(receiver.stats().decodeErrors).toBe(0);
    } finally {
      receiver.stop();
      track.stop();
    }
  });
}

it("counts invalid copy layouts as decode errors and closes every output", async () => {
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
