import { Decoder } from "@evan/opus";
import type { MediaStreamTrack, RtpPacket } from "werift";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  WERIFT_CHANNEL_COUNT,
  WERIFT_SAMPLE_RATE,
  createWeriftWebRTCFactory,
} from "../src/engine-werift.js";

/**
 * The werift audio source on a fake clock. Every RTP packet the source writes
 * to its local track is captured through the track's own `onReceiveRtp`
 * (werift media/track.js `writeRtp` executes it for each packet).
 */

const SLICE_FRAMES = (WERIFT_SAMPLE_RATE * 10) / 1000;

interface Written {
  sequenceNumber: number;
  timestamp: number;
  payload: Buffer;
}

const openSource = () => {
  const source = createWeriftWebRTCFactory().createAudioSource();
  const track = source.createTrack() as unknown as MediaStreamTrack;
  const written: Written[] = [];
  track.onReceiveRtp.subscribe((rtp: RtpPacket) => {
    written.push({
      sequenceNumber: rtp.header.sequenceNumber,
      timestamp: rtp.header.timestamp,
      payload: Buffer.from(rtp.payload),
    });
  });
  return { source, track, written };
};

/** `seconds` of a 1 kHz stereo tone at the wire format, as 10 ms slices. */
const writeTone = (source: ReturnType<typeof openSource>["source"], seconds: number): void => {
  for (let slice = 0; slice < seconds * 100; slice += 1) {
    const samples = new Int16Array(SLICE_FRAMES * WERIFT_CHANNEL_COUNT);
    for (let frame = 0; frame < SLICE_FRAMES; frame += 1) {
      const t = (slice * SLICE_FRAMES + frame) / WERIFT_SAMPLE_RATE;
      const value = Math.round(8_000 * Math.sin(2 * Math.PI * 1_000 * t));
      samples[frame * 2] = value;
      samples[frame * 2 + 1] = value;
    }
    source.onData({
      samples,
      sampleRate: WERIFT_SAMPLE_RATE,
      bitsPerSample: 16,
      channelCount: WERIFT_CHANNEL_COUNT,
      numberOfFrames: SLICE_FRAMES,
    });
  }
};

/** Every packet follows the one before it: sequence +1 (mod 2^16), timestamp +960. */
const expectContiguous = (written: Written[]): void => {
  for (let i = 1; i < written.length; i += 1) {
    expect(written[i]!.sequenceNumber).toBe((written[i - 1]!.sequenceNumber + 1) & 0xffff);
    expect(written[i]!.timestamp).toBe((written[i - 1]!.timestamp + 960) >>> 0);
  }
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("writes nothing before start(), then one Opus silence packet every 20 ms with nothing queued", async () => {
  const { source, track, written } = openSource();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(written).toHaveLength(0);

  source.start!();
  await vi.advanceTimersByTimeAsync(1_000);
  // One at once, then one per 20 ms tick.
  expect(written.length).toBeGreaterThanOrEqual(50);
  expect(written.length).toBeLessThanOrEqual(51);
  expectContiguous(written);
  const silence = written[0]!.payload;
  expect(silence.length).toBeGreaterThan(0);
  expect(written.every((packet) => packet.payload.equals(silence))).toBe(true);
  const pcm = new Decoder({ channels: 2, sample_rate: WERIFT_SAMPLE_RATE }).decode(silence);
  expect(pcm.byteLength).toBe(960 * 2 * 2);
  const stats = source.stats!();
  expect(stats).toMatchObject({ opusPackets: 0, rtpPackets: 0, silencePackets: written.length, queued: 0, pacerAlive: true });

  await vi.advanceTimersByTimeAsync(1_000);
  expect(written.length).toBeGreaterThanOrEqual(100);
  expect(written.length).toBeLessThanOrEqual(101);
  track.stop();
  const stoppedAt = written.length;
  await vi.advanceTimersByTimeAsync(1_000);
  expect(written).toHaveLength(stoppedAt);
  expect(source.stats!().pacerAlive).toBe(false);
});

it("replaces silence with 1 s of queued audio on one unbroken sequence, then returns to silence", async () => {
  const { source, track, written } = openSource();
  source.start!();
  await vi.advanceTimersByTimeAsync(100);
  const silence = written[0]!.payload;
  const before = written.length;

  writeTone(source, 1);
  expect(source.queuedMs!()).toBe(1_000);
  await vi.advanceTimersByTimeAsync(1_500);
  track.stop();

  expectContiguous(written);
  const kinds = written.map((packet) => (packet.payload.equals(silence) ? "s" : "a")).join("");
  // Silence, then exactly the 50 application packets back to back, then silence again.
  expect(kinds).toMatch(/^s+a{50}s+$/u);
  expect(kinds.indexOf("a")).toBe(before);
  expect(kinds.length - kinds.lastIndexOf("a") - 1).toBeGreaterThanOrEqual(20);
  const stats = source.stats!();
  expect(stats.opusPackets).toBe(50);
  expect(stats.rtpPackets).toBe(50);
  expect(stats.silencePackets).toBe(written.length - 50);
});

it("resolves waitForDrain once the queued audio has left, while silence keeps flowing", async () => {
  const { source, track, written } = openSource();
  source.start!();
  await vi.advanceTimersByTimeAsync(100);
  await source.waitForDrain!();

  writeTone(source, 0.2);
  let drained = false;
  void source.waitForDrain!().then(() => { drained = true; });
  await vi.advanceTimersByTimeAsync(100);
  expect(drained).toBe(false);
  await vi.advanceTimersByTimeAsync(140);
  expect(drained).toBe(true);
  expect(source.queuedMs!()).toBe(0);
  const drainedAt = written.length;
  await vi.advanceTimersByTimeAsync(200);
  expect(written.length).toBeGreaterThan(drainedAt + 8);
  track.stop();
});

it("returns to silence at once on clear() and releases waitForDrain", async () => {
  const { source, track, written } = openSource();
  source.start!();
  await vi.advanceTimersByTimeAsync(40);
  const silence = written[0]!.payload;
  writeTone(source, 1);
  let drained = false;
  void source.waitForDrain!().then(() => { drained = true; });
  await vi.advanceTimersByTimeAsync(200);
  source.clear!();
  await vi.advanceTimersByTimeAsync(0);
  expect(drained).toBe(true);
  const clearedAt = written.length;
  await vi.advanceTimersByTimeAsync(200);
  track.stop();

  expectContiguous(written);
  const after = written.slice(clearedAt);
  expect(after.length).toBeGreaterThanOrEqual(10);
  expect(after.every((packet) => packet.payload.equals(silence))).toBe(true);
});
