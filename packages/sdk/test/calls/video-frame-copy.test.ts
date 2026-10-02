import { expect, it, vi } from "vitest";
import { copyDecodedI420, H264I420InputGuard } from "../../src/calls/video-frame-copy.js";
import { loadWebCodecs } from "../../src/calls/engine-werift-video.js";

const fake = (layout = [{ offset: 0, stride: 4 }, { offset: 8, stride: 2 }, { offset: 10, stride: 2 }], size = 12) => ({
  format: "I420" as const, codedWidth: 4, codedHeight: 2,
  _getNative() {
    return { format: this.format, width: this.codedWidth, height: this.codedHeight,
      allocationSize: () => this.codedWidth * this.codedHeight + 2 * Math.ceil(this.codedWidth / 2) * Math.ceil(this.codedHeight / 2) };
  },
  allocationSize: vi.fn(() => size),
  copyTo: vi.fn(async (data: Uint8Array) => { data.set(Array.from({ length: size }, (_, i) => i)); return layout; }),
});

it("copies public I420 without a format conversion", async () => {
  const frame = fake();
  expect(await copyDecodedI420(frame)).toEqual(Uint8Array.from({ length: 12 }, (_, i) => i));
  expect(frame.allocationSize).toHaveBeenCalledWith(undefined);
  expect(frame.copyTo).toHaveBeenCalledWith(expect.any(Uint8Array), undefined);
});
it("repacks padded, offset and reordered planes by their returned layout", async () => {
  const frame = fake([{ offset: 2, stride: 6 }, { offset: 18, stride: 4 }, { offset: 14, stride: 4 }], 24);
  expect([...await copyDecodedI420(frame)]).toEqual([2, 3, 4, 5, 8, 9, 10, 11, 18, 19, 14, 15]);
});
it("supports odd dimensions when allocation and chroma layout are valid", async () => {
  const frame = { ...fake([{ offset: 0, stride: 3 }, { offset: 9, stride: 2 }, { offset: 13, stride: 2 }], 17), codedWidth: 3, codedHeight: 3 };
  expect((await copyDecodedI420(frame)).length).toBe(17);
});
for (const format of [null, "", "unknown", "I010"]) {
  it(`rejects unsupported format ${format}`, async () => {
    const frame = { ...fake(), format };
    await expect(copyDecodedI420(frame as never)).rejects.toThrow();
    expect(frame.copyTo).not.toHaveBeenCalled();
  });
}
for (const dimensions of [[0, 2], [-1, 2], [4, 1.5], [NaN, 2], [Infinity, 2], [Number.MAX_SAFE_INTEGER, 2]]) {
  it(`rejects invalid dimensions ${dimensions}`, async () => {
    const frame = { ...fake(), codedWidth: dimensions[0]!, codedHeight: dimensions[1]! };
    await expect(copyDecodedI420(frame)).rejects.toThrow();
    expect(frame.copyTo).not.toHaveBeenCalled();
  });
}
for (const size of [0, 11, -1, 12.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
  it(`rejects invalid allocation ${size}`, async () => {
    const frame = fake(undefined, size);
    await expect(copyDecodedI420(frame)).rejects.toThrow("allocation");
    expect(frame.copyTo).not.toHaveBeenCalled();
  });
}
for (const layout of [
  [], [{ offset: 0, stride: 4 }],
  [{ offset: -1, stride: 4 }, { offset: 8, stride: 2 }, { offset: 10, stride: 2 }],
  [{ offset: 0, stride: 3 }, { offset: 8, stride: 2 }, { offset: 10, stride: 2 }],
  [{ offset: 0, stride: 4.5 }, { offset: 8, stride: 2 }, { offset: 10, stride: 2 }],
  [{ offset: 0, stride: 4 }, { offset: 8, stride: 2 }, { offset: 11, stride: 2 }],
  [{ offset: 0, stride: 4 }, { offset: 7, stride: 2 }, { offset: 10, stride: 2 }],
  [{ offset: 0, stride: 4 }, { offset: 8, stride: 2 }, { offset: NaN, stride: 2 }],
]) {
  it(`rejects invalid layout ${JSON.stringify(layout)}`, async () => {
    await expect(copyDecodedI420(fake(layout))).rejects.toThrow();
  });
}
it("requests conversion for actual native NV12, preserving Y/U/V ordering", async () => {
  const wc = await loadWebCodecs();
  const frame = new wc.VideoFrame(Uint8Array.from([30, 40, 50, 60, 70, 80, 90, 100, 110, 150, 120, 160]), {
    format: "NV12", codedWidth: 4, codedHeight: 2, timestamp: 0,
  });
  const spy = vi.spyOn(frame, "copyTo");
  try {
    expect([...await copyDecodedI420(frame)]).toEqual([30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 150, 160]);
    expect(spy.mock.calls[0]![1]).toEqual({ format: "I420" });
  } finally { frame.close(); }
});

for (const format of ["I420A", "I422", "I444", "NV12", "RGBA", "RGBX", "BGRA", "BGRX"] as const) {
  it(`requests matching I420 allocation and copy options for ${format}`, async () => {
    const frame = { ...fake(), format };
    await copyDecodedI420(frame);
    expect(frame.allocationSize).toHaveBeenCalledWith({ format: "I420" });
    expect(frame.copyTo).toHaveBeenCalledWith(expect.any(Uint8Array), { format: "I420" });
  });
}

const sps = (profile: number) => Uint8Array.from([0, 0, 0, 1, 0x67, profile, 0, 31, 0x80]);
it("requires input proof AND real native allocation for masked I420", async () => {
  const frame = fake();
  frame._getNative = () => ({ format: "", width: 4, height: 2, allocationSize: () => 12 }) as never;
  await expect(copyDecodedI420(frame)).rejects.toThrow("Unverified");
  expect(frame.copyTo).not.toHaveBeenCalled();
  expect((await copyDecodedI420(frame, true)).length).toBe(12);
  for (const size of [8, 16, 24, 48]) {
    frame._getNative = () => ({ format: "", width: 4, height: 2, allocationSize: () => size }) as never;
    await expect(copyDecodedI420(frame, true)).rejects.toThrow("Unverified");
  }
});
it("fails closed when native binding inspection is missing", async () => {
  await expect(copyDecodedI420({ ...fake(), _getNative: undefined } as never, true)).rejects.toThrow("binding");
  await expect(copyDecodedI420({ ...fake(), _getNative: () => null }, true)).rejects.toThrow("native");
});
it("requires SPS proof and never re-enables an ambiguous decoder epoch", () => {
  const guard = new H264I420InputGuard();
  expect(guard.verified).toBe(false);
  guard.observe(sps(66));
  expect(guard.verified).toBe(true);
  guard.observe(sps(110)); // High 10 profile.
  expect(guard.verified).toBe(false);
  guard.observe(sps(66));
  expect(guard.verified).toBe(false);
});
it("rejects truncated/unsupported/subset SPS and accepts only implicit 8-bit 420 profiles", () => {
  for (const profile of [66, 77, 88, 100, 110, 122, 244]) {
    const guard = new H264I420InputGuard();
    guard.observe(sps(profile));
    expect(guard.verified).toBe([66, 77, 88].includes(profile));
  }
  for (const data of [sps(66).subarray(0, 7), Uint8Array.from([0, 0, 1, 0x6f, 66, 0, 31, 0x80])]) {
    const guard = new H264I420InputGuard();
    guard.observe(data);
    guard.observe(sps(66));
    expect(guard.verified).toBe(false);
  }
});
