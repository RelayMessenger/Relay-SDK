/**
 * Video RTP payloads: packetizing with `rtp-packet` 0.4.2 and depacketizing
 * with this file's own frame assembler.
 *
 * Why not werift's depacketizer: `DepacketizeCallback` with `waitForKeyframe`
 * glues frames together (measured 2026-09-22, /tmp/video-spike-webcodecs), and
 * `rtp-packet`'s `H264Depacketizer` keeps collecting NAL units across a lost
 * marker packet (src/h264.js:267-344: it emits on the marker bit only and never
 * looks at sequence numbers). A frame here is emitted only when every packet
 * from the previous frame's marker to its own marker arrived, so a loss
 * becomes a dropped frame and a keyframe request, never a corrupt frame.
 *
 * Formats: H.264 RFC 6184 (single NAL unit, STAP-A type 24, FU-A type 28;
 * packetization-mode=1), VP8 RFC 7741 (payload descriptor section 4.2, frame
 * start is S=1 with partition index 0, keyframe is P=0 in the first payload
 * header byte, section 4.3).
 */
import { H264Packetizer, VP8Packetizer } from "rtp-packet";

export type RelayVideoCodecName = "h264" | "vp8";

/** Largest RTP packet the packetizers write, as in the 2026-09-22 spike through Cloudflare's SFU. */
export const VIDEO_RTP_MTU = 1_200;
/** RTP video clock (RFC 6184 section 8.2.1, RFC 7741 section 6.1). */
export const VIDEO_CLOCK_RATE = 90_000;

const START_CODE = new Uint8Array([0, 0, 0, 1]);
const NAL_IDR = 5;
const NAL_SPS = 7;
const NAL_PPS = 8;
const NAL_AUD = 9;
const NAL_STAP_A = 24;
const NAL_FU_A = 28;

const opensAccessUnit = (type: number): boolean => type === NAL_AUD || type === NAL_SPS;

/** NAL units of an Annex-B access unit, start codes removed. */
export const splitAnnexB = (data: Uint8Array): Uint8Array[] => {
  const units: Uint8Array[] = [];
  let start = -1;
  let i = 0;
  while (i + 2 < data.length) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      if (start >= 0) {
        let end = i;
        while (end > start && data[end - 1] === 0) end -= 1;
        if (end > start) units.push(data.subarray(start, end));
      }
      i += 3;
      start = i;
    } else {
      i += 1;
    }
  }
  if (start >= 0 && start < data.length) units.push(data.subarray(start));
  return units;
};

const joinAnnexB = (units: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(units.reduce((sum, unit) => sum + START_CODE.length + unit.length, 0));
  let at = 0;
  for (const unit of units) {
    out.set(START_CODE, at);
    out.set(unit, at + START_CODE.length);
    at += START_CODE.length + unit.length;
  }
  return out;
};

export interface VideoPacketizer {
  /** RTP packets for one encoded frame; `timestampUs` is the capture time in microseconds. */
  packetize(data: Uint8Array, timestampUs: number, keyframe: boolean): Buffer[];
}

/**
 * H.264: SPS and PPS travel together in one STAP-A packet ahead of the rest
 * of the access unit, as libwebrtc sends them (RtpPacketizerH264 aggregates
 * small NAL units); every other NAL unit goes alone or as FU-A fragments.
 */
export const createVideoPacketizer = (
  codec: RelayVideoCodecName,
  options: { ssrc: number; payloadType: number; mtu?: number },
): VideoPacketizer => {
  const mtu = options.mtu ?? VIDEO_RTP_MTU;
  if (codec === "vp8") {
    const packetizer = new VP8Packetizer({ ssrc: options.ssrc, payloadType: options.payloadType, mtu, pictureId: true });
    return { packetize: (data, timestampUs) => packetizer.packetize({ data, timestamp: timestampUs }) };
  }
  const packetizer = new H264Packetizer({ ssrc: options.ssrc, payloadType: options.payloadType, mtu });
  return {
    packetize: (data, timestampUs) => {
      const units = splitAnnexB(data);
      const parameterSets = units.filter((unit) => {
        const type = unit[0]! & 0x1f;
        return type === NAL_SPS || type === NAL_PPS;
      });
      const rest = units.filter((unit) => !parameterSets.includes(unit));
      const packets: Buffer[] = [];
      const aggregate = parameterSets.length > 1
        && parameterSets.reduce((sum, unit) => sum + 2 + unit.length, 1) <= mtu;
      if (aggregate) packets.push(packetizer.packetizeStapA(parameterSets, timestampUs, rest.length === 0));
      const single = aggregate ? rest : units;
      if (single.length) packets.push(...packetizer.packetize({ nalus: single, timestamp: timestampUs }));
      return packets;
    },
  };
};

/** The fields of one RTP packet the assembler reads. */
export interface VideoRtpPacket {
  sequenceNumber: number;
  timestamp: number;
  marker: boolean;
  payload: Uint8Array;
}

export interface AssembledVideoFrame {
  /** H.264: an Annex-B access unit. VP8: the frame bitstream. */
  data: Uint8Array;
  keyframe: boolean;
  /** RTP timestamp, 90 kHz. */
  timestamp: number;
}

export type VideoFrameDropReason = "loss" | "malformed";

/** Payload bytes of one packet, or `undefined` when the packet cannot be used. */
interface PayloadPiece {
  bytes: Uint8Array[];
  /**
   * The packet provably begins a frame. VP8: S=1 and PID=0. H.264: its first
   * NAL unit is an access unit delimiter or an SPS, which only ever open an
   * access unit (H.264 section 7.4.1.2.3); otherwise not knowable from one packet.
   */
  frameStart: boolean;
  keyframe: boolean;
}

/** RFC 7741 section 4.2 descriptor length, or -1 when truncated. */
const vp8DescriptorLength = (payload: Uint8Array): number => {
  let at = 1;
  if (payload.length < 1) return -1;
  if (payload[0]! & 0x80) {
    if (payload.length < 2) return -1;
    const ext = payload[1]!;
    at = 2;
    if (ext & 0x80) {
      if (payload.length <= at) return -1;
      at += payload[at]! & 0x80 ? 2 : 1;
    }
    if (ext & 0x40) at += 1;
    if (ext & 0x30) at += 1;
  }
  return at <= payload.length ? at : -1;
};

/**
 * In-order RTP packets of one video stream in, whole frames out. Packets must
 * arrive in sequence order (a jitter buffer ahead of it reorders); any
 * sequence gap drops the frame it falls in, and `onDrop` asks for a keyframe.
 */
export class VideoFrameAssembler {
  readonly #codec: RelayVideoCodecName;
  readonly #onFrame: (frame: AssembledVideoFrame) => void;
  readonly #onDrop: (reason: VideoFrameDropReason) => void;
  #expectedSequence: number | undefined;
  #timestamp: number | undefined;
  #pieces: Uint8Array[] = [];
  #keyframe = false;
  #broken: VideoFrameDropReason | undefined;
  /** H.264 FU-A in progress, and its pieces so far. */
  #fragmenting = false;
  #fuParts: Uint8Array[] = [];
  /** A marker packet has been seen since the stream (re)started: the next packet begins a frame. */
  #synced = false;
  #frames = 0;
  #dropped = 0;

  constructor(
    codec: RelayVideoCodecName,
    onFrame: (frame: AssembledVideoFrame) => void,
    onDrop: (reason: VideoFrameDropReason) => void = () => undefined,
  ) {
    this.#codec = codec;
    this.#onFrame = onFrame;
    this.#onDrop = onDrop;
  }

  get frames(): number {
    return this.#frames;
  }

  get dropped(): number {
    return this.#dropped;
  }

  push(packet: VideoRtpPacket): void {
    const gap = this.#expectedSequence !== undefined && packet.sequenceNumber !== this.#expectedSequence;
    this.#expectedSequence = (packet.sequenceNumber + 1) & 0xffff;
    if (this.#timestamp !== undefined && packet.timestamp !== this.#timestamp) {
      // A new frame began before the current one saw its marker: its tail was lost.
      this.#finish(false);
    }
    const piece = this.#codec === "vp8" ? this.#vp8(packet.payload) : this.#h264(packet.payload);
    if (this.#timestamp === undefined) {
      this.#timestamp = packet.timestamp;
      // A frame is whole only if it provably starts here: VP8 marks its first
      // packet (S=1, PID=0); H.264 cannot, so its frame must follow the
      // previous frame's marker with no packet missing in between.
      const start = piece?.frameStart === true || (this.#codec === "h264" && this.#synced && !gap);
      if (!start) this.#broken = "loss";
    } else if (gap) {
      this.#broken = "loss";
    }
    if (!piece) this.#broken ??= "malformed";
    else {
      this.#pieces.push(...piece.bytes);
      if (piece.keyframe) this.#keyframe = true;
    }
    if (packet.marker) {
      this.#synced = true;
      this.#finish(true);
    }
  }

  /** Forget the frame in progress (the stream restarted). */
  reset(): void {
    this.#expectedSequence = undefined;
    this.#synced = false;
    this.#clear();
  }

  #finish(complete: boolean): void {
    const timestamp = this.#timestamp;
    if (timestamp === undefined) return;
    const broken = complete ? this.#broken ?? (this.#fragmenting ? "loss" : undefined) : "loss";
    const pieces = this.#pieces;
    const keyframe = this.#keyframe;
    this.#clear();
    if (broken || pieces.length === 0) {
      this.#dropped += 1;
      this.#onDrop(broken ?? "malformed");
      return;
    }
    const data = this.#codec === "vp8" ? concat(pieces) : joinAnnexB(pieces);
    this.#frames += 1;
    this.#onFrame({ data, keyframe, timestamp });
  }

  #clear(): void {
    this.#timestamp = undefined;
    this.#pieces = [];
    this.#keyframe = false;
    this.#broken = undefined;
    this.#fragmenting = false;
    this.#fuParts = [];
  }

  /** For H.264 each piece is one whole NAL unit; FU-A fragments are joined into one. */
  #h264(payload: Uint8Array): PayloadPiece | undefined {
    if (payload.length < 1) return undefined;
    const type = payload[0]! & 0x1f;
    if (type >= 1 && type <= 23) {
      if (this.#fragmenting) return undefined;
      return { bytes: [payload], frameStart: opensAccessUnit(type), keyframe: type === NAL_IDR };
    }
    if (type === NAL_STAP_A) {
      if (this.#fragmenting) return undefined;
      const units: Uint8Array[] = [];
      let at = 1;
      while (at + 2 <= payload.length) {
        const size = (payload[at]! << 8) | payload[at + 1]!;
        at += 2;
        if (size === 0 || at + size > payload.length) return undefined;
        units.push(payload.subarray(at, at + size));
        at += size;
      }
      if (at !== payload.length || units.length === 0) return undefined;
      return {
        bytes: units,
        frameStart: opensAccessUnit(units[0]![0]! & 0x1f),
        keyframe: units.some((unit) => (unit[0]! & 0x1f) === NAL_IDR),
      };
    }
    if (type === NAL_FU_A) {
      if (payload.length < 3) return undefined;
      const header = payload[1]!;
      const start = (header & 0x80) !== 0;
      const end = (header & 0x40) !== 0;
      const original = header & 0x1f;
      if (start) {
        if (this.#fragmenting) return undefined;
        this.#fragmenting = true;
        this.#fuParts = [new Uint8Array([(payload[0]! & 0xe0) | original]), payload.subarray(2)];
      } else {
        if (!this.#fragmenting) return undefined;
        this.#fuParts.push(payload.subarray(2));
      }
      if (!end) return { bytes: [], frameStart: false, keyframe: false };
      this.#fragmenting = false;
      const unit = concat(this.#fuParts);
      this.#fuParts = [];
      return { bytes: [unit], frameStart: false, keyframe: original === NAL_IDR };
    }
    // STAP-B, MTAP and FU-B belong to packetization-mode 2, which is never negotiated.
    return undefined;
  }

  #vp8(payload: Uint8Array): PayloadPiece | undefined {
    const length = vp8DescriptorLength(payload);
    if (length < 0 || length >= payload.length) return undefined;
    const start = (payload[0]! & 0x10) !== 0 && (payload[0]! & 0x07) === 0;
    const body = payload.subarray(length);
    return { bytes: [body], frameStart: start, keyframe: start && (body[0]! & 0x01) === 0 };
  }
}

const concat = (parts: Uint8Array[]): Uint8Array => {
  if (parts.length === 1) return parts[0]!;
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};
