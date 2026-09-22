import { beforeAll, expect, it, vi } from "vitest";
import { AgentSession, initializeLogger } from "@livekit/agents";
import { AudioFrame } from "@livekit/rtc-node";
import type { CallRoom, CallRoomEventMap, Relay } from "@relaymessenger/sdk";
import { RelayAudioInput, RelayAudioOutput, RelayLiveKitCall, createRelayLiveKitAudio } from "../src/livekit.js";
import type {
  RelayAudioFrame,
  RelayCallTransport,
  RelayPeerConnectionConfig,
  RelayPeerConnectionLike,
  RelayWebRTCFactory,
} from "../src/transport.js";

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

/** Minimal room + WebRTC fakes: the answer arrives at once and the peer connects. */
class ConnectingRoom {
  readonly listeners = new Map<string, Set<(...args: any[]) => void>>();
  async connect(): Promise<void> {}
  async reconnect(): Promise<void> {}
  send(frame: { type: string }): void {
    if (frame.type !== "offer") return;
    queueMicrotask(() => {
      for (const listener of this.listeners.get("answer") ?? []) {
        listener({ type: "answer", session_description: { type: "answer", sdp: "relay-answer" } });
      }
    });
  }
  connected(): void {}
  userUpdate(): void {}
  end(): void {}
  close(): void {}
  on<K extends Extract<keyof CallRoomEventMap, string>>(event: K, listener: (...args: any[]) => void): this {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return this;
  }
}

class ConnectingWebRTC implements RelayWebRTCFactory {
  readonly peerConfigs: RelayPeerConnectionConfig[] = [];
  neverConnects = false;
  createPeerConnection(config?: RelayPeerConnectionConfig): RelayPeerConnectionLike {
    if (config) this.peerConfigs.push(structuredClone(config));
    const peer: RelayPeerConnectionLike = {
      connectionState: "new",
      iceGatheringState: "complete",
      signalingState: "stable",
      localDescription: null,
      remoteDescription: null,
      onconnectionstatechange: null,
      ontrack: null,
      addTransceiver: () => ({ mid: "0" }),
      createOffer: async () => ({ type: "offer", sdp: "offer-sdp" }),
      createAnswer: async () => ({ type: "answer", sdp: "answer-sdp" }),
      setLocalDescription: async (description) => {
        (peer as { localDescription: RTCSessionDescription | null }).localDescription =
          description as RTCSessionDescription;
      },
      setRemoteDescription: async () => {
        if (this.neverConnects) return;
        (peer as { connectionState: string }).connectionState = "connected";
        queueMicrotask(() => peer.onconnectionstatechange?.());
      },
      addEventListener: () => {},
      removeEventListener: () => {},
      close: () => {},
    };
    return peer;
  }
  createAudioSource() {
    return { createTrack: () => ({ kind: "audio", stop: () => {} }), onData: () => {} };
  }
  createAudioSink() {
    return { ondata: null, stop: () => {} };
  }
}

it("forwards ICE servers, the transport policy and the media timeout through connect", async () => {
  const webRTC = new ConnectingWebRTC();
  const iceServers = [{ urls: "turn:turn.cloudflare.com:3478?transport=tcp", username: "u", credential: "c" }];
  const call = await RelayLiveKitCall.connect({
    relay: {} as Relay,
    callId: "01995bc0-0000-7000-8000-000000000001",
    roomClient: new ConnectingRoom() as unknown as CallRoom,
    webRTC,
    iceServers,
    iceTransportPolicy: "relay",
    mediaConnectTimeoutMs: 500,
  });
  expect(webRTC.peerConfigs).toEqual([{ iceServers, iceTransportPolicy: "relay" }]);
  expect(call.diagnostics().connected).toBe(true);
  expect(call.diagnostics().summary).toContain("local: host 0, srflx 0, relay 0");
  await call.close();

  const stuck = new ConnectingWebRTC();
  stuck.neverConnects = true;
  await expect(RelayLiveKitCall.connect({
    relay: {} as Relay,
    callId: "01995bc0-0000-7000-8000-000000000001",
    roomClient: new ConnectingRoom() as unknown as CallRoom,
    webRTC: stuck,
    mediaConnectTimeoutMs: 20,
  })).rejects.toThrow(/^Timed out connecting Relay WebRTC media \(local: host 0, srflx 0, relay 0; remote: none; states: no connected\)$/);
});
