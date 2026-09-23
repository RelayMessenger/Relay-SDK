/**
 * The part of `rtp-packet` 0.4.2 this package uses. The package ships plain
 * JavaScript with no declarations; shapes read from its src/h264.js,
 * src/vp8.js, src/rtp.js (`initPacketizer`, `makePacket`) and
 * src/jitter_buffer.js.
 */
declare module "rtp-packet" {
  export interface PacketizerOptions {
    ssrc: number;
    payloadType: number;
    /** Default 1400. */
    mtu?: number;
    /** Default random. */
    initialSequenceNumber?: number;
  }

  export interface PacketizerChunk {
    /** Codec bitstream; H.264 accepts Annex-B or AVCC. */
    data?: Uint8Array;
    /** H.264 only: NAL units without start codes, instead of `data`. */
    nalus?: Uint8Array[];
    /** Microseconds; converted to the 90 kHz RTP clock. */
    timestamp: number;
    type?: "key" | "delta";
  }

  export class H264Packetizer {
    constructor(options: PacketizerOptions);
    packetize(chunk: PacketizerChunk): Buffer[];
    /** One STAP-A packet carrying `nalus`; `marker` defaults to true. */
    packetizeStapA(nalus: Uint8Array[], timestampUs: number, marker?: boolean): Buffer;
    close(): void;
  }

  export class VP8Packetizer {
    /** `pictureId: true` writes a 15-bit PictureID, one per frame (RFC 7741 section 4.2). */
    constructor(options: PacketizerOptions & { pictureId?: boolean | number });
    packetize(chunk: PacketizerChunk): Buffer[];
    close(): void;
  }

  export interface JitterBufferPacket {
    sequenceNumber: number;
  }

  export class JitterBuffer<T extends JitterBufferPacket = JitterBufferPacket> {
    constructor(options: {
      /** ms to wait for a late packet before declaring it lost; default 50. */
      latency?: number;
      maxSize?: number;
      output?: (packet: T) => void;
      onLoss?: (sequenceNumber: number) => void;
    });
    push(packet: T): void;
    reset(): void;
    close(): void;
  }
}
