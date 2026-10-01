import { beforeAll, expect, it } from "vitest";
import { initializeLogger } from "@livekit/agents";
import { AudioFrame } from "@livekit/rtc-node";
import type { RelayAudioFrame, RelayCallTransport } from "@relaymessenger/sdk/calls";
import { RelayAudioOutput, type RelayLiveKitCall } from "../src/livekit.js";
import { RelayRive } from "../src/rive.js";

beforeAll(() => initializeLogger({ pretty: false, level: "silent" }));

/** The transport surface RelayAudioOutput and RelayRive touch, with a clock that advances by what is written. */
class FakeTransport {
  clockMs = 12_000;
  readonly sent: Array<[Record<string, unknown>, number | undefined]> = [];
  #playout: (() => void) | undefined;
  readonly channel = {
    set: (values: Record<string, unknown>, timing: { at?: number } = {}) => {
      this.sent.push([values, timing.at]);
      return true;
    },
  };
  async rive(): Promise<typeof this.channel> { return this.channel; }
  audioTimeMs(): number { return this.clockMs; }
  async writeAudio(frame: RelayAudioFrame): Promise<void> {
    this.clockMs += (frame.samples.length / frame.channelCount / frame.sampleRate) * 1_000;
  }
  queuedAudioMs(): number { return 0; }
  clearAudio(): void { this.#playout?.(); }
  waitForPlayout(): Promise<void> { return new Promise((resolve) => { this.#playout = resolve; }); }
  drain(): void { this.#playout?.(); }
}

const frame = (ms: number, rate = 48_000): AudioFrame =>
  new AudioFrame(new Int16Array((rate * ms) / 1_000), rate, 1, (rate * ms) / 1_000);

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 10; turn += 1) await new Promise((resolve) => setImmediate(resolve));
};

const callFor = (transport: FakeTransport): RelayLiveKitCall => ({
  transport: transport as unknown as RelayCallTransport,
  output: new RelayAudioOutput(transport as unknown as RelayCallTransport),
}) as unknown as RelayLiveKitCall;

it("sets speaking at the audio time the reply's first sample plays, and clears it with the mouth at rest", async () => {
  const transport = new FakeTransport();
  const call = callFor(transport);
  const avatar = new RelayRive();
  await avatar.start({ output: {} } as never, call);
  expect(avatar.rive).toBe(transport.channel);
  await call.output.captureFrame(frame(20));
  await call.output.captureFrame(frame(20));
  call.output.flush();
  transport.drain();
  await settle();
  expect(transport.sent).toEqual([
    [{ speaking: true }, 12_000],
    [{ speaking: false, viseme: 0 }, undefined],
  ]);
  // The next reply starts where the first one's audio ended on the track.
  await call.output.captureFrame(frame(20));
  expect(transport.sent.at(-1)).toEqual([{ speaking: true }, 12_040]);
});

it("renames or leaves out the properties", async () => {
  const transport = new FakeTransport();
  const call = callFor(transport);
  await new RelayRive({ speakingProperty: "talking", visemeProperty: null }).start({ output: {} } as never, call);
  await call.output.captureFrame(frame(20));
  call.output.flush();
  transport.drain();
  await settle();
  expect(transport.sent).toEqual([[{ talking: true }, 12_000], [{ talking: false }, undefined]]);
});
