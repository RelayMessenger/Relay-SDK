import { beforeAll, expect, it, vi } from "vitest";
import { AgentSession, initializeLogger } from "@livekit/agents";
import { AudioFrame } from "@livekit/rtc-node";
import { RelayAudioInput, RelayAudioOutput, createRelayLiveKitAudio } from "../src/livekit.js";
import type { RelayAudioFrame, RelayCallTransport } from "../src/transport.js";

class FakeTransport {
  readonly listeners = new Set<(frame: RelayAudioFrame) => void>();
  readonly writes: RelayAudioFrame[] = [];
  clears = 0;

  on(event: string, listener: (frame: RelayAudioFrame) => void): this {
    if (event === "audio") this.listeners.add(listener);
    return this;
  }
  off(event: string, listener: (frame: RelayAudioFrame) => void): this {
    if (event === "audio") this.listeners.delete(listener);
    return this;
  }
  emit(frame: RelayAudioFrame): void {
    for (const listener of this.listeners) listener(frame);
  }
  async writeAudio(frame: RelayAudioFrame): Promise<void> {
    this.writes.push({ ...frame, samples: frame.samples.slice() });
  }
  clearAudio(): void { this.clears += 1; }
}

beforeAll(() => initializeLogger({ pretty: false, level: "silent" }));

it("converts inbound Relay PCM into LiveKit AudioFrame input", async () => {
  const transport = new FakeTransport();
  const input = new RelayAudioInput(transport as unknown as RelayCallTransport);
  input.setAttached(true);
  const reader = input.stream.getReader();
  transport.emit({ samples: new Int16Array([10, 20, 30, 40]), sampleRate: 24_000, channelCount: 2 });
  const received = await reader.read();

  expect(received.done).toBe(false);
  expect(received.value).toBeInstanceOf(AudioFrame);
  expect(received.value?.sampleRate).toBe(24_000);
  expect(received.value?.channels).toBe(2);
  expect(received.value?.samplesPerChannel).toBe(2);
  expect([...(received.value?.data ?? [])]).toEqual([10, 20, 30, 40]);
  reader.releaseLock();
  await input.close();
  expect(transport.listeners.size).toBe(0);
});

it("converts LiveKit output frames to Relay PCM and clears interrupted audio", async () => {
  const transport = new FakeTransport();
  const output = new RelayAudioOutput(transport as unknown as RelayCallTransport);
  const started = vi.fn();
  output.on(RelayAudioOutput.EVENT_PLAYBACK_STARTED, started);
  const frame = new AudioFrame(new Int16Array(480), 48_000, 1, 480);
  await output.captureFrame(frame);

  expect(transport.writes).toHaveLength(1);
  expect(output.sampleRate).toBe(48_000);
  expect(transport.writes[0]?.sampleRate).toBe(48_000);
  expect(transport.writes[0]?.channelCount).toBe(1);
  expect(transport.writes[0]?.samples).toHaveLength(480);
  expect(started).toHaveBeenCalledTimes(1);

  output.clearBuffer();
  expect(transport.clears).toBe(1);
  output.close();
});

it("installs the reusable Relay audio pair on an existing AgentSession", async () => {
  const transport = new FakeTransport();
  const audio = createRelayLiveKitAudio(transport as unknown as RelayCallTransport);
  const session = new AgentSession({ vad: null });

  session.input.audio = audio.input;
  session.output.audio = audio.output;
  expect(session.input.audio).toBe(audio.input);
  expect(session.output.audio).toBe(audio.output);

  session.input.audio = null;
  session.output.audio = null;
  await audio.input.close();
  audio.output.close();
});
