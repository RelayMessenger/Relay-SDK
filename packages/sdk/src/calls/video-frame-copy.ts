import { createRequire } from "node:module";
import { splitAnnexB } from "./video-rtp.js";

type DecodedFrame = Pick<InstanceType<typeof import("node-webcodecs")["VideoFrame"]>,
  "format" | "codedWidth" | "codedHeight" | "allocationSize" | "copyTo">;

/** Unknown native formats are allowed only for baseline/main/extended H264:
 * these profiles imply 8-bit 4:2:0. Any other SPS poisons this decoder epoch,
 * so queued outputs cannot inherit a later, more permissive parameter set.
 */
export class H264I420InputGuard {
  #seen = false;
  #safe = true;

  observe(data: Uint8Array): void {
    for (const nal of splitAnnexB(data)) {
      const type = nal[0]! & 0x1f;
      if (type === 15) this.#safe = false; // Subset SPS: not supported by this guard.
      if (type !== 7) continue;
      this.#seen = true;
      if (nal.length < 5 || (nal[0]! & 0x80) !== 0 || ![66, 77, 88].includes(nal[1]!)) this.#safe = false;
    }
  }

  get verified(): boolean { return this.#seen && this.#safe; }
}

const require = createRequire(import.meta.url);
let bindingVersion: string | undefined;

/** This internal binding inspection is deliberately pinned and fail-closed.
 * 1.3.0's native allocationSize uses av_image_get_buffer_size on the REAL
 * AVFrame format; unlike JS allocation/layout it does not use the I420 fallback.
 */
const nativeFormat = (frame: DecodedFrame, tightSize: number, verifiedH264: boolean): string => {
  bindingVersion ??= (require("node-webcodecs/package.json") as { version: string }).version;
  const getNative = (frame as DecodedFrame & { _getNative?: () => unknown })._getNative;
  if (bindingVersion !== "1.3.0" || typeof getNative !== "function") {
    throw new Error("Unsupported node-webcodecs frame binding");
  }
  const native = getNative.call(frame) as {
    format?: unknown; width?: unknown; height?: unknown; allocationSize?: () => number;
  } | null;
  if (!native || typeof native.format !== "string" || typeof native.allocationSize !== "function"
    || native.width !== frame.codedWidth || native.height !== frame.codedHeight) {
    throw new Error("Invalid native video frame");
  }
  if (native.format === "I420" || native.format === "") {
    if (frame.format !== "I420" || native.allocationSize() !== tightSize
      || (native.format === "" && !verifiedH264)) throw new Error("Unverified native I420 frame");
    return "I420";
  }
  if (native.format !== frame.format) throw new Error("Mismatched native video format");
  return native.format;
};

/** Copy a verified decoder frame into tight Y/U/V planes. */
export const copyDecodedI420 = async (frame: DecodedFrame, verifiedH264 = false): Promise<Uint8Array> => {
  const width = frame.codedWidth;
  const height = frame.codedHeight;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new Error("Invalid decoded video dimensions");
  }
  const cw = Math.ceil(width / 2);
  const ch = Math.ceil(height / 2);
  const tightSize = width * height + 2 * cw * ch;
  if (!Number.isSafeInteger(tightSize)) throw new Error("Invalid decoded video allocation");
  const format = nativeFormat(frame, tightSize, verifiedH264);
  if (!["I420", "I420A", "I422", "I444", "NV12", "RGBA", "RGBX", "BGRA", "BGRX"].includes(format)) {
    throw new Error("Unsupported decoded video format");
  }
  // Full-range H264 native YUVJ420P is already planar I420 byte layout.
  // node-webcodecs 1.3 exposes it as I420 but its redundant explicit I420
  // conversion loses the chroma pointers. Preserve the native samples instead.
  // This preserves range, not normalizes it: Relay's public frame has no range
  // metadata, and its existing RGB conversion assumes limited range.
  const options = format === "I420" ? undefined : { format: "I420" as const };
  const size = frame.allocationSize(options);
  if (!Number.isSafeInteger(size) || size < tightSize) {
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
