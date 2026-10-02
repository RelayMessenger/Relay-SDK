type DecodedFrame = Pick<InstanceType<typeof import("node-webcodecs")["VideoFrame"]>,
  "format" | "codedWidth" | "codedHeight" | "allocationSize" | "copyTo">;

/** Copy a decoder frame into tight Y/U/V planes, using only WebCodecs' public surface. */
export const copyDecodedI420 = async (frame: DecodedFrame): Promise<Uint8Array> => {
  const width = frame.codedWidth;
  const height = frame.codedHeight;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new Error("Invalid decoded video dimensions");
  }
  // Never treat an unknown format as planar bytes. These are the formats that
  // node-webcodecs supports converting to I420.
  if (!["I420", "I420A", "I422", "I444", "NV12", "RGBA", "RGBX", "BGRA", "BGRX"].includes(frame.format ?? "")) {
    throw new Error("Unsupported decoded video format");
  }
  // Full-range H264 native YUVJ420P is already planar I420 byte layout.
  // node-webcodecs 1.3 exposes it as I420 but its redundant explicit I420
  // conversion loses the chroma pointers. Preserve the native samples instead.
  // This preserves range, not normalizes it: Relay's public frame has no range
  // metadata, and its existing RGB conversion assumes limited range.
  const options = frame.format === "I420" ? undefined : { format: "I420" as const };
  const cw = Math.ceil(width / 2);
  const ch = Math.ceil(height / 2);
  const tightSize = width * height + 2 * cw * ch;
  const size = frame.allocationSize(options);
  if (!Number.isSafeInteger(tightSize) || !Number.isSafeInteger(size) || size < tightSize || size > 0xffffffff) {
    throw new Error("Invalid decoded video allocation");
  }
  const data = new Uint8Array(size);
  const layout = await frame.copyTo(data, options);
  if (!Array.isArray(layout) || layout.length !== 3) throw new Error("Invalid I420 plane count");
  const widths = [width, cw, cw];
  const heights = [height, ch, ch];
  const ends: number[] = [];
  for (let p = 0; p < 3; p++) {
    const plane = layout[p];
    if (!plane || !Number.isSafeInteger(plane.offset) || !Number.isSafeInteger(plane.stride)
      || plane.offset < 0 || plane.stride < widths[p]!) throw new Error("Invalid I420 plane layout");
    const end = plane.offset + (heights[p]! - 1) * plane.stride + widths[p]!;
    if (!Number.isSafeInteger(end) || end > size) throw new Error("I420 plane exceeds allocation");
    for (let other = 0; other < p; other++) {
      if (plane.offset < ends[other]! && layout[other]!.offset < end) throw new Error("Overlapping I420 planes");
    }
    ends.push(end);
  }
  const offsets = [0, width * height, width * height + cw * ch];
  if (layout.every((plane, p) => plane.offset === offsets[p] && plane.stride === widths[p])) {
    return data.subarray(0, tightSize);
  }
  const tight = new Uint8Array(tightSize);
  for (let p = 0; p < 3; p++) {
    const { offset, stride } = layout[p]!;
    for (let row = 0; row < heights[p]!; row++) {
      const start = offset + row * stride;
      tight.set(data.subarray(start, start + widths[p]!), offsets[p]! + row * widths[p]!);
    }
  }
  return tight;
};
