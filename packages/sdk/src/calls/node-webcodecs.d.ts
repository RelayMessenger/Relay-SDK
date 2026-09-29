/**
 * The part of `node-webcodecs` 1.3.0 this package uses. Shapes copied from
 * its dist/index.d.ts, VideoEncoder.d.ts, VideoDecoder.d.ts, VideoFrame.d.ts,
 * EncodedVideoChunk.d.ts and types.d.ts.
 *
 * Declared here because the package is an optional peer that cannot install
 * everywhere: 1.3.0 ships prebuilds for darwin-arm64, linux-arm64 and
 * linux-x64 only, so on Windows its install script falls back to a cmake-js
 * source build that needs FFmpeg dev libraries, fails, and npm drops the
 * optional package. The SDK must still type-check and build there; video
 * then fails at run time in `loadWebCodecs` with a clear reason.
 */
declare module "node-webcodecs" {
  type BufferSource = ArrayBuffer | ArrayBufferView;
  type CodecState = "unconfigured" | "configured" | "closed";
  type HardwareAcceleration = "no-preference" | "prefer-hardware" | "prefer-software";

  export type VideoPixelFormat = "I420" | "I420A" | "I422" | "I444" | "NV12" | "RGBA" | "RGBX" | "BGRA" | "BGRX";

  export interface PlaneLayout {
    offset: number;
    stride: number;
  }

  export interface VideoFrameBufferInit {
    format: VideoPixelFormat;
    codedWidth: number;
    codedHeight: number;
    timestamp: number;
    duration?: number;
    displayWidth?: number;
    displayHeight?: number;
  }

  export interface VideoFrameCopyToOptions {
    rect?: { x: number; y: number; width: number; height: number };
    layout?: PlaneLayout[];
    format?: VideoPixelFormat;
  }

  export class VideoFrame {
    constructor(data: BufferSource, init: VideoFrameBufferInit);
    get format(): VideoPixelFormat | null;
    get codedWidth(): number;
    get codedHeight(): number;
    get timestamp(): number;
    allocationSize(options?: VideoFrameCopyToOptions): number;
    copyTo(destination: BufferSource, options?: VideoFrameCopyToOptions): Promise<PlaneLayout[]>;
    close(): void;
  }

  export type EncodedVideoChunkType = "key" | "delta";

  export interface EncodedVideoChunkInit {
    type: EncodedVideoChunkType;
    timestamp: number;
    duration?: number;
    data: BufferSource;
  }

  export class EncodedVideoChunk {
    constructor(init: EncodedVideoChunkInit);
    readonly type: EncodedVideoChunkType;
    readonly timestamp: number;
    readonly duration: number | null;
    readonly byteLength: number;
    copyTo(destination: BufferSource): void;
  }

  export interface VideoEncoderConfig {
    codec: string;
    width: number;
    height: number;
    bitrate?: number;
    framerate?: number;
    hardwareAcceleration?: HardwareAcceleration;
    latencyMode?: "quality" | "realtime";
    avc?: { format?: "annexb" | "avc" };
  }

  export interface VideoEncoderInit {
    output: (chunk: EncodedVideoChunk) => void;
    error: (error: Error) => void;
  }

  export class VideoEncoder {
    constructor(init: VideoEncoderInit);
    get state(): CodecState;
    get encodeQueueSize(): number;
    configure(config: VideoEncoderConfig): void;
    encode(frame: VideoFrame, options?: { keyFrame?: boolean }): void;
    flush(): Promise<void>;
    close(): void;
  }

  export interface VideoDecoderConfig {
    codec: string;
    codedWidth?: number;
    codedHeight?: number;
    hardwareAcceleration?: HardwareAcceleration;
    optimizeForLatency?: boolean;
    description?: BufferSource;
  }

  export interface VideoDecoderInit {
    output: (frame: VideoFrame) => void;
    error: (error: Error) => void;
  }

  export class VideoDecoder {
    constructor(init: VideoDecoderInit);
    get state(): CodecState;
    get decodeQueueSize(): number;
    configure(config: VideoDecoderConfig): void;
    decode(chunk: EncodedVideoChunk): void;
    flush(): Promise<void>;
    close(): void;
  }

  export function isNativeAvailable(): boolean;
}
