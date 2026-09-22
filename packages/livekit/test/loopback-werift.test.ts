import { expect, it } from "vitest";
import type { RelayMediaStreamTrackLike, RelayPeerConnectionLike } from "../src/transport.js";
import {
  WERIFT_CHANNEL_COUNT,
  WERIFT_SAMPLE_RATE,
  createWeriftWebRTCFactory,
} from "../src/engine-werift.js";

/**
 * Real loopback: two werift peer connections on this machine, offer/answer
 * wired by hand, A publishes a 1 kHz sine through the Opus encoder path for
 * one second, B decodes through the sink path. No Relay room, no SFU.
 */

const TONE_HZ = 1_000;
const TONE_AMPLITUDE = 8_000;
const SLICE_MS = 10;
const SLICES = 100;

const waitForIce = (peer: RelayPeerConnectionLike): Promise<void> =>
  new Promise((resolve) => {
    if (peer.iceGatheringState === "complete") return resolve();
    const changed = (): void => {
      if (peer.iceGatheringState !== "complete") return;
      peer.removeEventListener("icegatheringstatechange", changed);
      resolve();
    };
    peer.addEventListener("icegatheringstatechange", changed);
  });

const waitForConnected = (peer: RelayPeerConnectionLike): Promise<void> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`peer stuck in ${peer.connectionState}`)), 10_000);
    peer.onconnectionstatechange = () => {
      if (peer.connectionState === "connected") {
        clearTimeout(timer);
        resolve();
      } else if (peer.connectionState === "failed") {
        clearTimeout(timer);
        reject(new Error("peer connection failed"));
      }
    };
  });

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const sineSlice = (sliceIndex: number, amplitude: number): Int16Array => {
  const frames = (WERIFT_SAMPLE_RATE * SLICE_MS) / 1000;
  const out = new Int16Array(frames * WERIFT_CHANNEL_COUNT);
  for (let frame = 0; frame < frames; frame += 1) {
    const t = (sliceIndex * frames + frame) / WERIFT_SAMPLE_RATE;
    const value = Math.round(amplitude * Math.sin(2 * Math.PI * TONE_HZ * t));
    out[frame * 2] = value;
    out[frame * 2 + 1] = value;
  }
  return out;
};

/** RMS over the left channel of interleaved stereo PCM16. */
const rms = (samples: Int16Array): number => {
  let sum = 0;
  let count = 0;
  for (let i = 0; i < samples.length; i += 2) {
    sum += samples[i]! * samples[i]!;
    count += 1;
  }
  return Math.sqrt(sum / count);
};

/** Dominant frequency by plain DFT over 4800 left-channel samples, 100 Hz bins up to 4 kHz. */
const dominantHz = (samples: Int16Array): number => {
  const n = 4_800;
  const left = new Float64Array(n);
  for (let i = 0; i < n; i += 1) left[i] = samples[i * 2]!;
  let bestHz = 0;
  let bestPower = -1;
  for (let hz = 100; hz <= 4_000; hz += 50) {
    let re = 0;
    let im = 0;
    for (let i = 0; i < n; i += 1) {
      const angle = (2 * Math.PI * hz * i) / WERIFT_SAMPLE_RATE;
      re += left[i]! * Math.cos(angle);
      im -= left[i]! * Math.sin(angle);
    }
    const power = re * re + im * im;
    if (power > bestPower) {
      bestPower = power;
      bestHz = hz;
    }
  }
  return bestHz;
};

it("carries a 1 kHz sine from A to B over werift + Opus on loopback", async () => {
  const factory = createWeriftWebRTCFactory();
  const a = factory.createPeerConnection();
  const b = factory.createPeerConnection();
  const source = factory.createAudioSource();
  const localTrack = source.createTrack();
  expect(localTrack.kind).toBe("audio");
  a.addTransceiver(localTrack, { direction: "sendonly" });

  const decoded: Int16Array[] = [];
  const remoteTrack = new Promise<RelayMediaStreamTrackLike>((resolve) => {
    b.ontrack = (event) => resolve(event.track);
  });

  const aConnected = waitForConnected(a);
  const bConnected = waitForConnected(b);
  const offer = await a.createOffer();
  await a.setLocalDescription(offer);
  await waitForIce(a);
  await b.setRemoteDescription({ type: "offer", sdp: a.localDescription!.sdp });
  const answer = await b.createAnswer();
  await b.setLocalDescription(answer);
  await waitForIce(b);
  await a.setRemoteDescription({ type: "answer", sdp: b.localDescription!.sdp });
  await Promise.all([aConnected, bConnected]);

  const sink = factory.createAudioSink(await remoteTrack);
  sink.ondata = (data) => {
    expect(data.sampleRate).toBe(WERIFT_SAMPLE_RATE);
    expect(data.channelCount).toBe(WERIFT_CHANNEL_COUNT);
    decoded.push(data.samples);
  };

  for (let slice = 0; slice < SLICES; slice += 1) {
    source.onData({
      samples: sineSlice(slice, TONE_AMPLITUDE),
      sampleRate: WERIFT_SAMPLE_RATE,
      bitsPerSample: 16,
      channelCount: WERIFT_CHANNEL_COUNT,
      numberOfFrames: (WERIFT_SAMPLE_RATE * SLICE_MS) / 1000,
    });
    await sleep(SLICE_MS);
  }
  await sleep(300);

  sink.stop();
  localTrack.stop();
  a.close();
  b.close();

  expect(decoded.length).toBeGreaterThanOrEqual(40);
  const all = new Int16Array(decoded.reduce((n, frame) => n + frame.length, 0));
  let offset = 0;
  for (const frame of decoded) {
    all.set(frame, offset);
    offset += frame.length;
  }
  // Skip the first 200 ms (Opus warm-up) before measuring.
  const steady = all.subarray(WERIFT_SAMPLE_RATE * WERIFT_CHANNEL_COUNT / 5);
  expect(rms(steady)).toBeGreaterThan(1_000);
  const hz = dominantHz(steady);
  expect(hz).toBeGreaterThanOrEqual(TONE_HZ - 50);
  expect(hz).toBeLessThanOrEqual(TONE_HZ + 50);
}, 30_000);
