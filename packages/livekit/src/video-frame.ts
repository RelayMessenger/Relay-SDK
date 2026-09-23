/**
 * Raw video frames, with LiveKit's public shape.
 *
 * Copied from `@livekit/rtc-node` 0.13.35 (node_modules/@livekit/rtc-node/src):
 * - video_frame.ts:12-23: `new VideoFrame(data, width, height, type)` with the
 *   public fields `data`, `width`, `height`, `type`; `getPlane(n)` (:75) and
 *   `convert(dstType, flipY = false)` (:83).
 * - video_frame.ts:106-129 `getPlaneLength` and :131 `getPlaneInfos`: plane
 *   sizes with chroma planes of `(width + 1) / 2` by `(height + 1) / 2`.
 * - @livekit/rtc-ffi-bindings proto/video_frame_pb.d.ts:58-130: the numeric
 *   values of `VideoRotation` and `VideoBufferType`.
 *
 * LiveKit converts through its native FFI; this file converts in TypeScript
 * with libyuv's BT.601 limited-range integer formulas, the ones WebRTC uses
 * for `I420ToARGB` / `ARGBToI420`.
 */

/** Pixel layouts, same names and numbers as LiveKit's `VideoBufferType`. */
export enum VideoBufferType {
  RGBA = 0,
  ABGR = 1,
  ARGB = 2,
  BGRA = 3,
  RGB24 = 4,
  I420 = 5,
  I420A = 6,
  I422 = 7,
  I444 = 8,
  I010 = 9,
  NV12 = 10,
}

/** Same names and numbers as LiveKit's `VideoRotation`. */
export enum VideoRotation {
  VIDEO_ROTATION_0 = 0,
  VIDEO_ROTATION_90 = 1,
  VIDEO_ROTATION_180 = 2,
  VIDEO_ROTATION_270 = 3,
}

const chroma = (size: number): number => Math.trunc((size + 1) / 2);

/** Byte length of a tightly packed frame of `type`. */
export const videoFrameLength = (type: VideoBufferType, width: number, height: number): number => {
  const cw = chroma(width);
  const ch = chroma(height);
  switch (type) {
    case VideoBufferType.RGBA:
    case VideoBufferType.ABGR:
    case VideoBufferType.ARGB:
    case VideoBufferType.BGRA:
      return width * height * 4;
    case VideoBufferType.RGB24:
    case VideoBufferType.I444:
      return width * height * 3;
    case VideoBufferType.I420:
      return width * height + cw * ch * 2;
    case VideoBufferType.I420A:
      return width * height * 2 + cw * ch * 2;
    case VideoBufferType.I422:
      return width * height + cw * height * 2;
    case VideoBufferType.I010:
      return width * height * 2 + cw * ch * 4;
    case VideoBufferType.NV12:
      return width * height + cw * ch * 2;
  }
};

/** [offset, size] of each plane of a tightly packed frame. */
const planes = (type: VideoBufferType, width: number, height: number): Array<[number, number]> => {
  const cw = chroma(width);
  const ch = chroma(height);
  const y = width * height;
  switch (type) {
    case VideoBufferType.I420:
      return [[0, y], [y, cw * ch], [y + cw * ch, cw * ch]];
    case VideoBufferType.I420A:
      return [[0, y], [y, cw * ch], [y + cw * ch, cw * ch], [y + 2 * cw * ch, y]];
    case VideoBufferType.I422:
      return [[0, y], [y, cw * height], [y + cw * height, cw * height]];
    case VideoBufferType.I444:
      return [[0, y], [y, y], [2 * y, y]];
    case VideoBufferType.I010:
      return [[0, y * 2], [y * 2, cw * ch * 2], [y * 2 + cw * ch * 2, cw * ch * 2]];
    case VideoBufferType.NV12:
      return [[0, y], [y, cw * ch * 2]];
    default:
      return [[0, videoFrameLength(type, width, height)]];
  }
};

/** Byte offsets of R, G, B and alpha (-1: none) and bytes per pixel. */
const PACKED: Partial<Record<VideoBufferType, { r: number; g: number; b: number; a: number; bpp: number }>> = {
  [VideoBufferType.RGBA]: { r: 0, g: 1, b: 2, a: 3, bpp: 4 },
  [VideoBufferType.BGRA]: { r: 2, g: 1, b: 0, a: 3, bpp: 4 },
  [VideoBufferType.ARGB]: { r: 1, g: 2, b: 3, a: 0, bpp: 4 },
  [VideoBufferType.ABGR]: { r: 3, g: 2, b: 1, a: 0, bpp: 4 },
  [VideoBufferType.RGB24]: { r: 0, g: 1, b: 2, a: -1, bpp: 3 },
};

const clamp = (value: number): number => (value < 0 ? 0 : value > 255 ? 255 : value);

/** libyuv BT.601 limited range, fixed point (RGBToY / RGBToU / RGBToV in row_common.cc). */
export const rgbToY = (r: number, g: number, b: number): number => ((66 * r + 129 * g + 25 * b + 128) >> 8) + 16;
const rgbToU = (r: number, g: number, b: number): number => ((-38 * r - 74 * g + 112 * b + 128) >> 8) + 128;
const rgbToV = (r: number, g: number, b: number): number => ((112 * r - 94 * g - 18 * b + 128) >> 8) + 128;

const i420ToPacked = (
  data: Uint8Array,
  width: number,
  height: number,
  dst: VideoBufferType,
  flipY: boolean,
): Uint8Array => {
  const layout = PACKED[dst]!;
  const out = new Uint8Array(width * height * layout.bpp);
  const cw = chroma(width);
  const uBase = width * height;
  const vBase = uBase + cw * chroma(height);
  for (let row = 0; row < height; row += 1) {
    const outRow = flipY ? height - 1 - row : row;
    for (let col = 0; col < width; col += 1) {
      const c = data[row * width + col]! - 16;
      const d = data[uBase + (row >> 1) * cw + (col >> 1)]! - 128;
      const e = data[vBase + (row >> 1) * cw + (col >> 1)]! - 128;
      const at = (outRow * width + col) * layout.bpp;
      out[at + layout.r] = clamp((298 * c + 409 * e + 128) >> 8);
      out[at + layout.g] = clamp((298 * c - 100 * d - 208 * e + 128) >> 8);
      out[at + layout.b] = clamp((298 * c + 516 * d + 128) >> 8);
      if (layout.a >= 0) out[at + layout.a] = 255;
    }
  }
  return out;
};

const packedToI420 = (
  data: Uint8Array,
  width: number,
  height: number,
  src: VideoBufferType,
  flipY: boolean,
): Uint8Array => {
  const layout = PACKED[src]!;
  const cw = chroma(width);
  const ch = chroma(height);
  const out = new Uint8Array(videoFrameLength(VideoBufferType.I420, width, height));
  const uBase = width * height;
  const vBase = uBase + cw * ch;
  const pixel = (row: number, col: number): [number, number, number] => {
    const srcRow = flipY ? height - 1 - row : row;
    const at = (srcRow * width + col) * layout.bpp;
    return [data[at + layout.r]!, data[at + layout.g]!, data[at + layout.b]!];
  };
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      const [r, g, b] = pixel(row, col);
      out[row * width + col] = rgbToY(r, g, b);
    }
  }
  for (let row = 0; row < ch; row += 1) {
    for (let col = 0; col < cw; col += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let dy = 0; dy < 2; dy += 1) {
        for (let dx = 0; dx < 2; dx += 1) {
          const y = row * 2 + dy;
          const x = col * 2 + dx;
          if (y >= height || x >= width) continue;
          const [pr, pg, pb] = pixel(y, x);
          r += pr;
          g += pg;
          b += pb;
          n += 1;
        }
      }
      r = Math.round(r / n);
      g = Math.round(g / n);
      b = Math.round(b / n);
      out[uBase + row * cw + col] = rgbToU(r, g, b);
      out[vBase + row * cw + col] = rgbToV(r, g, b);
    }
  }
  return out;
};

const packedToPacked = (
  data: Uint8Array,
  width: number,
  height: number,
  src: VideoBufferType,
  dst: VideoBufferType,
  flipY: boolean,
): Uint8Array => {
  const from = PACKED[src]!;
  const to = PACKED[dst]!;
  const out = new Uint8Array(width * height * to.bpp);
  for (let row = 0; row < height; row += 1) {
    const outRow = flipY ? height - 1 - row : row;
    for (let col = 0; col < width; col += 1) {
      const a = (row * width + col) * from.bpp;
      const b = (outRow * width + col) * to.bpp;
      out[b + to.r] = data[a + from.r]!;
      out[b + to.g] = data[a + from.g]!;
      out[b + to.b] = data[a + from.b]!;
      if (to.a >= 0) out[b + to.a] = from.a >= 0 ? data[a + from.a]! : 255;
    }
  }
  return out;
};

const flipI420 = (data: Uint8Array, width: number, height: number): Uint8Array => {
  const out = new Uint8Array(data.length);
  const flipPlane = (offset: number, w: number, h: number): void => {
    for (let row = 0; row < h; row += 1) {
      out.set(data.subarray(offset + row * w, offset + (row + 1) * w), offset + (h - 1 - row) * w);
    }
  };
  const cw = chroma(width);
  const ch = chroma(height);
  flipPlane(0, width, height);
  flipPlane(width * height, cw, ch);
  flipPlane(width * height + cw * ch, cw, ch);
  return out;
};

export class VideoFrame {
  data: Uint8Array;
  width: number;
  height: number;
  type: VideoBufferType;

  constructor(data: Uint8Array, width: number, height: number, type: VideoBufferType) {
    this.data = data;
    this.width = width;
    this.height = height;
    this.type = type;
  }

  /** A copy of plane `planeNth` (Y, U, V for I420; the whole buffer for packed RGB). */
  getPlane(planeNth: number): Uint8Array | void {
    const list = planes(this.type, this.width, this.height);
    if (planeNth >= list.length) return;
    const [offset, size] = list[planeNth]!;
    return this.data.slice(offset, offset + size);
  }

  /**
   * A new frame in `dstType`. Supported: I420 and the packed RGB layouts
   * (RGBA, BGRA, ARGB, ABGR, RGB24), in any direction between them.
   */
  convert(dstType: VideoBufferType, flipY = false): VideoFrame {
    const { data, width, height, type } = this;
    const expected = videoFrameLength(type, width, height);
    if (data.length < expected) {
      throw new Error(`VideoFrame data holds ${data.length} bytes; ${VideoBufferType[type]} ${width}x${height} needs ${expected}.`);
    }
    const make = (bytes: Uint8Array): VideoFrame => new VideoFrame(bytes, width, height, dstType);
    const srcPacked = PACKED[type] !== undefined;
    const dstPacked = PACKED[dstType] !== undefined;
    if (type === VideoBufferType.I420 && dstType === VideoBufferType.I420) {
      return make(flipY ? flipI420(data, width, height) : data.slice(0, expected));
    }
    if (type === VideoBufferType.I420 && dstPacked) return make(i420ToPacked(data, width, height, dstType, flipY));
    if (srcPacked && dstType === VideoBufferType.I420) return make(packedToI420(data, width, height, type, flipY));
    if (srcPacked && dstPacked) return make(packedToPacked(data, width, height, type, dstType, flipY));
    throw new Error(`VideoFrame.convert does not support ${VideoBufferType[type]} to ${VideoBufferType[dstType]}.`);
  }
}
