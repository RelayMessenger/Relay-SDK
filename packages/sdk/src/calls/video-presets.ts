/**
 * The encoding a camera track gets when the caller passes no `videoEncoding`:
 * LiveKit's camera presets and the rule that picks one for a frame size,
 * copied from livekit/client-sdk-js at 5cadc938:
 * - `VideoPresets` and `VideoPresets43`, src/room/track/options.ts:507-532
 *   https://github.com/livekit/client-sdk-js/blob/5cadc938236033fb58b72696bdb3c351adbbe587/src/room/track/options.ts#L507-L532
 * - `determineAppropriateEncoding` and `presetsForResolution`,
 *   src/room/participant/publishUtils.ts:310-368
 *   https://github.com/livekit/client-sdk-js/blob/5cadc938236033fb58b72696bdb3c351adbbe587/src/room/participant/publishUtils.ts#L310-L368
 *
 * The 16:9 or 4:3 list is the one whose aspect ratio is nearer the frame's;
 * the preset is the first whose width reaches the frame's longer side, else
 * the largest. LiveKit changes the bitrate only for VP9, AV1 and H.265, so the
 * two codecs Relay sends, H.264 and VP8, take the table as it is. Screen-share
 * presets are left out: a Relay call publishes one camera track.
 *
 * LiveKit's Rust SDK, under `@livekit/rtc-node` and `livekit.rtc`, breaks on
 * `preset.width > size` instead (livekit/rust-sdks livekit/src/room/options.rs
 * `compute_appropriate_encoding`), so a frame exactly a preset's width gets the
 * next preset up there; this file follows the client SDK, where 1920x1080 gets
 * `h1080`.
 */
import type { VideoEncoding } from "./video.js";

interface VideoPreset {
  readonly width: number;
  readonly height: number;
  readonly maxBitrate: number;
  readonly maxFramerate: number;
}

const preset = (width: number, height: number, maxBitrate: number, maxFramerate: number): VideoPreset =>
  ({ width, height, maxBitrate, maxFramerate });

/** LiveKit `VideoPresets` (16:9). */
export const VIDEO_PRESETS_169: readonly VideoPreset[] = [
  preset(160, 90, 90_000, 20),
  preset(320, 180, 160_000, 20),
  preset(384, 216, 180_000, 20),
  preset(640, 360, 450_000, 20),
  preset(960, 540, 800_000, 25),
  preset(1280, 720, 1_700_000, 30),
  preset(1920, 1080, 3_000_000, 30),
  preset(2560, 1440, 5_000_000, 30),
  preset(3840, 2160, 8_000_000, 30),
];

/** LiveKit `VideoPresets43` (4:3). */
export const VIDEO_PRESETS_43: readonly VideoPreset[] = [
  preset(160, 120, 70_000, 20),
  preset(240, 180, 125_000, 20),
  preset(320, 240, 140_000, 20),
  preset(480, 360, 330_000, 20),
  preset(640, 480, 500_000, 20),
  preset(720, 540, 600_000, 25),
  preset(960, 720, 1_300_000, 30),
  preset(1440, 1080, 2_300_000, 30),
  preset(1920, 1440, 3_800_000, 30),
];

/** LiveKit `determineAppropriateEncoding` for a camera frame of `width` x `height`. */
export const defaultVideoEncoding = (width: number, height: number): Required<VideoEncoding> & { maxBitrate: number } => {
  const aspect = width > height ? width / height : height / width;
  const presets = Math.abs(aspect - 16 / 9) < Math.abs(aspect - 4 / 3) ? VIDEO_PRESETS_169 : VIDEO_PRESETS_43;
  // Portrait frames use their longer side, as LiveKit does.
  const size = Math.max(width, height);
  let chosen = presets[0]!;
  for (const candidate of presets) {
    chosen = candidate;
    if (candidate.width >= size) break;
  }
  return { maxBitrate: chosen.maxBitrate, maxFramerate: chosen.maxFramerate };
};
