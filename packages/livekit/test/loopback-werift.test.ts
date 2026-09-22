import { expect, it } from "vitest";
import type { CallRoom, CallRoomEventMap, Relay } from "@relaymessenger/sdk";
import {
  RelayCallTransport,
  type RelayMediaStreamTrackLike,
  type RelayPeerConnectionLike,
} from "../src/transport.js";
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

  const sink = factory.createAudioSink(await remoteTrack, {
    sampleRate: WERIFT_SAMPLE_RATE,
    channelCount: WERIFT_CHANNEL_COUNT,
  });
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

/** Two werift peers, A sendonly to B, wired by hand. */
const connectPair = async (factory: ReturnType<typeof createWeriftWebRTCFactory>) => {
  const a = factory.createPeerConnection();
  const b = factory.createPeerConnection();
  const source = factory.createAudioSource();
  const localTrack = source.createTrack();
  a.addTransceiver(localTrack, { direction: "sendonly" });
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
  return { a, b, source, localTrack, remoteTrack: await remoteTrack };
};

/** Sign changes in mono PCM16, zeros skipped; a sine at f Hz has 2f per second. */
const zeroCrossings = (samples: Int16Array): number => {
  let crossings = 0;
  let previous = 0;
  for (const sample of samples) {
    if (sample === 0) continue;
    const sign = sample > 0 ? 1 : -1;
    if (previous !== 0 && sign !== previous) crossings += 1;
    previous = sign;
  }
  return crossings;
};

it("decodes 48 kHz stereo Opus straight to 24 kHz mono when the sink asks for it", async () => {
  const toneHz = 440;
  const factory = createWeriftWebRTCFactory();
  const { a, b, source, localTrack, remoteTrack } = await connectPair(factory);
  const sink = factory.createAudioSink(remoteTrack, { sampleRate: 24_000, channelCount: 1 });
  const formats = new Set<string>();
  const decoded: Int16Array[] = [];
  sink.ondata = (data) => {
    formats.add(`${data.sampleRate}/${data.channelCount}/${data.numberOfFrames === data.samples.length}`);
    decoded.push(data.samples);
  };

  // Send 1.5 s of a 440 Hz stereo tone at 48 kHz, the wire format.
  const frames = (WERIFT_SAMPLE_RATE * SLICE_MS) / 1000;
  for (let slice = 0; slice < 150; slice += 1) {
    const out = new Int16Array(frames * WERIFT_CHANNEL_COUNT);
    for (let frame = 0; frame < frames; frame += 1) {
      const t = (slice * frames + frame) / WERIFT_SAMPLE_RATE;
      const value = Math.round(TONE_AMPLITUDE * Math.sin(2 * Math.PI * toneHz * t));
      out[frame * 2] = value;
      out[frame * 2 + 1] = value;
    }
    source.onData({
      samples: out,
      sampleRate: WERIFT_SAMPLE_RATE,
      bitsPerSample: 16,
      channelCount: WERIFT_CHANNEL_COUNT,
      numberOfFrames: frames,
    });
    await sleep(SLICE_MS);
  }
  await sleep(300);
  sink.stop();
  localTrack.stop();
  a.close();
  b.close();

  expect([...formats]).toEqual(["24000/1/true"]);
  const all = new Int16Array(decoded.reduce((n, frame) => n + frame.length, 0));
  let offset = 0;
  for (const frame of decoded) {
    all.set(frame, offset);
    offset += frame.length;
  }
  // Skip 200 ms of Opus warm-up, then measure exactly one second: 24000 samples.
  const second = all.subarray(4_800, 4_800 + 24_000);
  expect(second.length).toBe(24_000);
  expect(rms(second)).toBeGreaterThan(1_000);
  const crossings = zeroCrossings(second);
  expect(crossings).toBeGreaterThanOrEqual(880 * 0.9);
  expect(crossings).toBeLessThanOrEqual(880 * 1.1);
  // One 20 ms Opus packet decodes to 480 mono samples at 24 kHz.
  expect(decoded.every((frame) => frame.length === 480)).toBe(true);
}, 30_000);

type RoomEvent = Extract<keyof CallRoomEventMap, string>;

/** Signaling stand-in: frames the transport sends land in `sent`; the test replies with `emit`. */
class LoopbackRoom {
  readonly listeners = new Map<string, Set<(...args: any[]) => void>>();
  readonly sent: Array<Record<string, any>> = [];
  readonly waiters: Array<(frame: Record<string, any>) => void> = [];
  async connect(): Promise<void> {}
  async reconnect(): Promise<void> {}
  send(frame: unknown): void {
    const copy = structuredClone(frame) as Record<string, any>;
    this.sent.push(copy);
    this.waiters.splice(0).forEach((resolve) => resolve(copy));
  }
  next(type: string): Promise<Record<string, any>> {
    return new Promise((resolve) => {
      const check = (frame: Record<string, any>): void => {
        if (frame.type === type) resolve(frame);
        else this.waiters.push(check);
      };
      this.waiters.push(check);
    });
  }
  connected(): void { this.send({ type: "connected" }); }
  userUpdate(): void {}
  end(): void {}
  close(): void {}
  on<K extends RoomEvent>(event: K, listener: (...args: CallRoomEventMap[K]) => void): this {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener as (...args: any[]) => void);
    this.listeners.set(event, listeners);
    return this;
  }
  emit<K extends RoomEvent>(event: K, ...args: CallRoomEventMap[K]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

it("counts RTP both ways in diagnostics() over a werift loopback through the transport", async () => {
  const factory = createWeriftWebRTCFactory();
  const room = new LoopbackRoom();
  const transport = new RelayCallTransport({
    relay: {} as Relay,
    callId: "01995bc0-0000-7000-8000-000000000001",
    roomClient: room as unknown as CallRoom,
    webRTC: factory,
  });
  const inbound: Int16Array[] = [];
  transport.on("audio", (frame) => inbound.push(frame.samples));

  // The far side: a bare werift peer playing Cloudflare's role. It answers the
  // transport's sendonly offer, then offers its own sendonly track back.
  const far = factory.createPeerConnection();
  const farSource = factory.createAudioSource();
  const farTrack = farSource.createTrack();
  const decoded: Int16Array[] = [];
  const farRemote = new Promise<RelayMediaStreamTrackLike>((resolve) => {
    far.ontrack = (event) => resolve(event.track);
  });

  const publishOffer = room.next("offer");
  const connecting = transport.connect();
  const offer = await publishOffer;
  await far.setRemoteDescription(offer.session_description);
  const answer = await far.createAnswer();
  await far.setLocalDescription(answer);
  await waitForIce(far);
  room.emit("answer", {
    type: "answer",
    session_description: { type: "answer", sdp: far.localDescription!.sdp },
  });
  await connecting;
  expect(transport.diagnostics().connected).toBe(true);

  const farSink = factory.createAudioSink(await farRemote, {
    sampleRate: WERIFT_SAMPLE_RATE,
    channelCount: WERIFT_CHANNEL_COUNT,
  });
  farSink.ondata = (data) => decoded.push(data.samples);

  // Pull: the far side renegotiates with a sendonly track, as the SFU's subscription offer does.
  far.addTransceiver(farTrack, { direction: "sendonly" });
  const pullOffer = await far.createOffer();
  await far.setLocalDescription(pullOffer);
  await waitForIce(far);
  const pullAnswer = room.next("answer");
  room.emit("offer", {
    type: "offer",
    session_description: { type: "offer", sdp: far.localDescription!.sdp },
    track: "audio",
  });
  await far.setRemoteDescription((await pullAnswer).session_description);

  // Push the whole second at once (LiveKit pushes faster than real time); the
  // engine's 20 ms pump paces the wire and waitForPlayout() reports the drain.
  const pushStarted = performance.now();
  for (let slice = 0; slice < SLICES; slice += 1) {
    await transport.writeAudio({
      samples: sineSlice(slice, TONE_AMPLITUDE),
      sampleRate: WERIFT_SAMPLE_RATE,
      channelCount: WERIFT_CHANNEL_COUNT,
    });
    farSource.onData({
      samples: sineSlice(slice, TONE_AMPLITUDE),
      sampleRate: WERIFT_SAMPLE_RATE,
      bitsPerSample: 16,
      channelCount: WERIFT_CHANNEL_COUNT,
      numberOfFrames: (WERIFT_SAMPLE_RATE * SLICE_MS) / 1000,
    });
  }
  const pushMs = performance.now() - pushStarted;
  expect(pushMs).toBeLessThan(200);
  expect(transport.queuedAudioMs()).toBeGreaterThan(900);
  await transport.waitForPlayout();
  const playoutMs = performance.now() - pushStarted;
  expect(playoutMs).toBeGreaterThanOrEqual(900);
  expect(playoutMs).toBeLessThanOrEqual(1_600);
  expect(transport.queuedAudioMs()).toBe(0);
  await sleep(300);

  const diagnostics = transport.diagnostics();
  transport.close();
  farSink.stop();
  farTrack.stop();
  far.close();

  expect(diagnostics.outbound.frames).toBe(SLICES);
  expect(diagnostics.outbound.opusPackets).toBe(SLICES / 2);
  expect(diagnostics.outbound.rtpPackets).toBe(SLICES / 2);
  expect(diagnostics.outbound.queued).toBe(0);
  expect(diagnostics.outbound.firstPacketAtMs).toBeGreaterThan(0);
  expect(diagnostics.inbound.rtpPackets).toBeGreaterThan(40);
  expect(diagnostics.inbound.decodeFailures).toBe(0);
  expect(diagnostics.inbound.frames).toBe(diagnostics.inbound.rtpPackets);
  expect(inbound.length).toBeGreaterThan(40);
  expect(decoded.length).toBeGreaterThan(40);
  expect(diagnostics.room).toEqual({ roomStates: 0, offers: 1, endedReason: undefined, errors: [] });
  expect(diagnostics.summary).toMatch(/in: \d+ rtp, 0 bad, \d+ frames, first \d+\.\ds last \d+\.\ds, \d+\/5s; out: 100 frames, 50 opus, \d+ rtp, first \d+\.\ds last \d+\.\ds, \d+\/5s, queue 0, pacer idle; room: 0 roomState, 1 offer/);
}, 30_000);

/** A werift peer playing the SFU: answers the transport's publish offer. */
const answerAsSfu = async (
  factory: ReturnType<typeof createWeriftWebRTCFactory>,
  room: LoopbackRoom,
  offer: Record<string, any>,
) => {
  const sfu = factory.createPeerConnection();
  const track = new Promise<RelayMediaStreamTrackLike>((resolve) => {
    sfu.ontrack = (event) => resolve(event.track);
  });
  await sfu.setRemoteDescription(offer.session_description);
  const answer = await sfu.createAnswer();
  await sfu.setLocalDescription(answer);
  await waitForIce(sfu);
  room.emit("answer", { type: "answer", session_description: { type: "answer", sdp: sfu.localDescription!.sdp } });
  return { sfu, track };
};

it("restarts onto a new werift session when the first never connects; the tone reaches the new session", async () => {
  const factory = createWeriftWebRTCFactory();
  const room = new LoopbackRoom();
  const transport = new RelayCallTransport({
    relay: {} as Relay,
    callId: "01995bc0-0000-7000-8000-000000000001",
    roomClient: room as unknown as CallRoom,
    webRTC: factory,
  });
  const restarts: string[] = [];
  transport.on("restarted", (event) => restarts.push(event.reason));

  // First session: answered, then its far side is gone, so no STUN check is
  // ever answered: the dead-session shape measured on Cloudflare 2026-09-22.
  const firstOffer = room.next("offer");
  const connecting = transport.connect();
  const dead = await answerAsSfu(factory, room, await firstOffer);
  const restartOffer = room.next("offer");
  await sleep(50);
  dead.sfu.close();

  const second = await restartOffer;
  expect(second.restart).toBe(true);
  expect(second.tracks).toEqual([{ mid: "0", name: "audio" }]);
  const live = await answerAsSfu(factory, room, second);
  await connecting;
  expect(restarts).toHaveLength(1);
  expect(transport.diagnostics().restarts).toBe(1);

  const decoded: Int16Array[] = [];
  const sink = factory.createAudioSink(await live.track, {
    sampleRate: WERIFT_SAMPLE_RATE,
    channelCount: WERIFT_CHANNEL_COUNT,
  });
  sink.ondata = (data) => decoded.push(data.samples);
  for (let slice = 0; slice < SLICES; slice += 1) {
    await transport.writeAudio({
      samples: sineSlice(slice, TONE_AMPLITUDE),
      sampleRate: WERIFT_SAMPLE_RATE,
      channelCount: WERIFT_CHANNEL_COUNT,
    });
  }
  await transport.waitForPlayout();
  await sleep(300);
  transport.close();
  sink.stop();
  live.sfu.close();

  expect(decoded.length).toBeGreaterThanOrEqual(40);
  const all = new Int16Array(decoded.reduce((n, frame) => n + frame.length, 0));
  let offset = 0;
  for (const frame of decoded) {
    all.set(frame, offset);
    offset += frame.length;
  }
  const steady = all.subarray(WERIFT_SAMPLE_RATE * WERIFT_CHANNEL_COUNT / 5);
  expect(rms(steady)).toBeGreaterThan(1_000);
  const hz = dominantHz(steady);
  expect(hz).toBeGreaterThanOrEqual(TONE_HZ - 50);
  expect(hz).toBeLessThanOrEqual(TONE_HZ + 50);
}, 30_000);

it("answers a pull offer carrying a video m-line receive-only and keeps receiving audio", async () => {
  const factory = createWeriftWebRTCFactory();
  const room = new LoopbackRoom();
  const transport = new RelayCallTransport({
    relay: {} as Relay,
    callId: "01995bc0-0000-7000-8000-000000000001",
    roomClient: room as unknown as CallRoom,
    webRTC: factory,
  });
  const errors: Error[] = [];
  transport.on("error", (error) => errors.push(error));
  const inbound: Int16Array[] = [];
  transport.on("audio", (frame) => inbound.push(frame.samples));

  const offer = room.next("offer");
  const connecting = transport.connect();
  const { sfu } = await answerAsSfu(factory, room, await offer);
  await connecting;

  // The SFU pulls the person's audio and camera into this session: two
  // sendonly m-lines, video with werift's default video codecs.
  const { MediaStreamTrack } = await import("werift");
  const personAudio = factory.createAudioSource();
  const personAudioTrack = personAudio.createTrack();
  sfu.addTransceiver(personAudioTrack, { direction: "sendonly" });
  sfu.addTransceiver(new MediaStreamTrack({ kind: "video" }) as unknown as RelayMediaStreamTrackLike, {
    direction: "sendonly",
  });
  const pullOffer = await sfu.createOffer();
  await sfu.setLocalDescription(pullOffer);
  await waitForIce(sfu);
  const videoOffer = sfu.localDescription!.sdp;
  expect(videoOffer).toMatch(/m=video /u);
  const pullAnswer = room.next("answer");
  room.emit("offer", {
    type: "offer",
    session_description: { type: "offer", sdp: videoOffer },
    track: "video",
  });
  const answer = (await pullAnswer).session_description.sdp as string;
  const videoSection = answer.slice(answer.indexOf("m=video"));
  expect(videoSection).toMatch(/^m=video [1-9]/u);
  expect(videoSection).toMatch(/a=recvonly/u);
  await sfu.setRemoteDescription({ type: "answer", sdp: answer });

  for (let slice = 0; slice < 50; slice += 1) {
    personAudio.onData({
      samples: sineSlice(slice, TONE_AMPLITUDE),
      sampleRate: WERIFT_SAMPLE_RATE,
      bitsPerSample: 16,
      channelCount: WERIFT_CHANNEL_COUNT,
      numberOfFrames: (WERIFT_SAMPLE_RATE * SLICE_MS) / 1000,
    });
    await sleep(SLICE_MS);
  }
  await sleep(300);
  transport.close();
  personAudioTrack.stop();
  sfu.close();

  expect(errors).toEqual([]);
  expect(inbound.length).toBeGreaterThan(15);
}, 30_000);
