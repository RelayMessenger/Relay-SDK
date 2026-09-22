import { beforeEach, expect, it, vi } from "vitest";
import type {
  CallRoom,
  CallRoomEventMap,
  CallRoomServerAnswerFrame,
  CallRoomStateFrame,
  CallRoomSubscriptionOfferFrame,
  Relay,
} from "@relaymessenger/sdk";
import {
  RelayCallTransport,
  RelayCallTransportError,
  type RelayAudioSinkLike,
  type RelayAudioSourceLike,
  type RelayMediaStreamTrackLike,
  type RelayPeerConnectionLike,
  type RelayWebRTCFactory,
} from "../src/transport.js";

type RoomEvent = Extract<keyof CallRoomEventMap, string>;

class FakeRoom {
  readonly listeners = new Map<string, Set<(...args: any[]) => void>>();
  readonly sent: unknown[] = [];
  connects = 0;
  reconnects = 0;
  closes = 0;

  async connect(): Promise<void> { this.connects += 1; }
  async reconnect(): Promise<void> { this.reconnects += 1; }
  send(frame: unknown): void { this.sent.push(structuredClone(frame)); }
  connected(): void { this.send({ type: "connected" }); }
  userUpdate(update: { muted: boolean }): void { this.send({ type: "userUpdate", muted: update.muted }); }
  end(): void { this.send({ type: "end" }); }
  close(): void { this.closes += 1; }
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

class FakeTrack implements RelayMediaStreamTrackLike {
  kind = "audio";
  stopped = false;
  stop(): void { this.stopped = true; }
}

class FakeAudioSource implements RelayAudioSourceLike {
  readonly track = new FakeTrack();
  readonly data: Parameters<RelayAudioSourceLike["onData"]>[0][] = [];
  createTrack(): RelayMediaStreamTrackLike { return this.track; }
  onData(data: Parameters<RelayAudioSourceLike["onData"]>[0]): void {
    this.data.push({ ...data, samples: data.samples.slice() });
  }
}

class FakeAudioSink implements RelayAudioSinkLike {
  ondata: RelayAudioSinkLike["ondata"] = null;
  stopped = false;
  stop(): void { this.stopped = true; }
}

class FakePeer implements RelayPeerConnectionLike {
  connectionState = "new";
  iceGatheringState = "complete";
  signalingState = "stable";
  localDescription: RTCSessionDescription | null = null;
  remoteDescription: RTCSessionDescription | null = null;
  onconnectionstatechange: (() => void) | null = null;
  ontrack: ((event: { track: RelayMediaStreamTrackLike }) => void) | null = null;
  readonly transceiver = { mid: "0" };
  direction: "sendonly" | undefined;
  closed = false;

  addTransceiver(
    _track: RelayMediaStreamTrackLike,
    init: { direction: "sendonly" },
  ): { mid: string } {
    this.direction = init.direction;
    return this.transceiver;
  }
  async createOffer(): Promise<RTCSessionDescriptionInit> { return { type: "offer", sdp: "offer-sdp" }; }
  async createAnswer(): Promise<RTCSessionDescriptionInit> { return { type: "answer", sdp: "answer-sdp" }; }
  async setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = description as RTCSessionDescription;
    if (description.type === "answer") this.signalingState = "stable";
    else this.signalingState = "have-local-offer";
  }
  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = description as RTCSessionDescription;
    if (description.type === "offer") {
      this.signalingState = "have-remote-offer";
    } else {
      this.signalingState = "stable";
      this.connectionState = "connected";
      queueMicrotask(() => this.onconnectionstatechange?.());
    }
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void { this.closed = true; this.connectionState = "closed"; }
}

class FakeWebRTC implements RelayWebRTCFactory {
  readonly peer = new FakePeer();
  readonly source = new FakeAudioSource();
  readonly sinks: FakeAudioSink[] = [];
  createPeerConnection(): RelayPeerConnectionLike { return this.peer; }
  createAudioSource(): RelayAudioSourceLike { return this.source; }
  createAudioSink(): RelayAudioSinkLike {
    const sink = new FakeAudioSink();
    this.sinks.push(sink);
    return sink;
  }
}

const flush = async (): Promise<void> => {
  for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
};

const connectTransport = async (
  transport: RelayCallTransport,
  room: FakeRoom,
): Promise<void> => {
  const connecting = transport.connect();
  await flush();
  room.emit("answer", {
    type: "answer",
    session_description: { type: "answer", sdp: "relay-answer" },
  });
  await connecting;
};

const makeTransport = (room: FakeRoom, webRTC: FakeWebRTC): RelayCallTransport =>
  new RelayCallTransport({
    relay: {} as Relay,
    callId: "01995bc0-0000-7000-8000-000000000001",
    roomClient: room as unknown as CallRoom,
    webRTC,
  });

beforeEach(() => vi.useRealTimers());

it("publishes exactly one Relay audio track and handles server renegotiation", async () => {
  const room = new FakeRoom();
  const webRTC = new FakeWebRTC();
  const transport = makeTransport(room, webRTC);
  let connected = false;
  const connecting = transport.connect().then(() => { connected = true; });
  await flush();

  expect(room.connects).toBe(1);
  expect(connected).toBe(false);
  expect(room.sent[0]).toEqual({
    type: "offer",
    session_description: { type: "offer", sdp: "offer-sdp" },
    tracks: [{ mid: "0", name: "audio" }],
  });
  expect(webRTC.peer.direction).toBe("sendonly");

  const answer: CallRoomServerAnswerFrame = {
    type: "answer", session_description: { type: "answer", sdp: "relay-answer" },
  };
  room.emit("answer", answer);
  await connecting;

  expect(webRTC.peer.remoteDescription?.sdp).toBe("relay-answer");
  expect(connected).toBe(true);
  expect(room.sent.at(-1)).toEqual({ type: "connected" });

  const offer: CallRoomSubscriptionOfferFrame = {
    type: "offer", session_description: { type: "offer", sdp: "relay-subscription" }, track: "audio",
  };
  room.emit("offer", offer);
  await flush();
  expect(room.sent.at(-1)).toEqual({
    type: "answer", session_description: { type: "answer", sdp: "answer-sdp" },
  });
  transport.close();
});

it("converts WebRTC sink/source PCM at the provider-neutral boundary", async () => {
  vi.useFakeTimers();
  const room = new FakeRoom();
  const webRTC = new FakeWebRTC();
  const transport = makeTransport(room, webRTC);
  const incoming: Int16Array[] = [];
  transport.on("audio", (frame) => incoming.push(frame.samples));
  await connectTransport(transport, room);

  const remoteTrack = new FakeTrack();
  webRTC.peer.ontrack?.({ track: remoteTrack });
  const nativeSamples = new Int16Array([1, 2, 3, 4]);
  webRTC.sinks[0]?.ondata?.({ samples: nativeSamples, sampleRate: 48_000, bitsPerSample: 16, channelCount: 1 });
  nativeSamples[0] = 99;
  expect([...incoming[0]!]).toEqual([1, 2, 3, 4]);

  const outgoing = transport.writeAudio({
    samples: new Int16Array(960),
    sampleRate: 48_000,
    channelCount: 1,
  });
  await vi.advanceTimersByTimeAsync(20);
  await outgoing;
  expect(webRTC.source.data).toHaveLength(2);
  expect(webRTC.source.data.map((frame) => frame.numberOfFrames)).toEqual([480, 480]);
  expect(webRTC.source.data.every((frame) => frame.bitsPerSample === 16)).toBe(true);
  transport.close();
});

it("reconnects signaling by replaying the same publication and ignores the cached answer", async () => {
  const room = new FakeRoom();
  const webRTC = new FakeWebRTC();
  const transport = makeTransport(room, webRTC);
  await connectTransport(transport, room);
  const firstOffer = structuredClone(room.sent[0]);

  await transport.reconnect();
  expect(room.reconnects).toBe(1);
  expect(room.sent.at(-1)).toEqual(firstOffer);
  room.emit("answer", { type: "answer", session_description: { type: "answer", sdp: "relay-answer" } });
  await flush();
  expect(webRTC.peer.remoteDescription?.sdp).toBe("relay-answer");
  transport.close();
});

it("surfaces room errors and releases media when the Call ends", async () => {
  const room = new FakeRoom();
  const webRTC = new FakeWebRTC();
  const transport = makeTransport(room, webRTC);
  const errors: Error[] = [];
  transport.on("error", (error) => errors.push(error));
  await connectTransport(transport, room);
  webRTC.peer.ontrack?.({ track: new FakeTrack() });

  room.emit("error", { type: "error", code: "media_unavailable", message: "media down" });
  expect(errors[0]).toBeInstanceOf(RelayCallTransportError);
  expect((errors[0] as RelayCallTransportError).code).toBe("media_unavailable");

  room.emit("ended", { type: "ended", reason: "completed" });
  expect(webRTC.peer.closed).toBe(true);
  expect(webRTC.source.track.stopped).toBe(true);
  expect(webRTC.sinks[0]?.stopped).toBe(true);
  transport.close();
});

it("forwards room state and sends call end through the Relay control room", async () => {
  const room = new FakeRoom();
  const webRTC = new FakeWebRTC();
  const transport = makeTransport(room, webRTC);
  await connectTransport(transport, room);
  const statuses: string[] = [];
  transport.on("roomState", (frame) => statuses.push(frame.call.status));

  const state = {
    type: "roomState",
    call: {
      id: "01995bc0-0000-7000-8000-000000000001",
      chat_id: "01995bc0-0000-7000-8000-000000000002",
      from: { id: "user", handle: "alice", kind: "user" },
      to: [{ id: "agent", handle: "relay", kind: "agent" }],
      mode: "audio",
      status: "in-progress",
      revision: 2,
      created_at: "2026-09-22T00:00:00Z",
      ringing_at: "2026-09-22T00:00:00Z",
      answered_at: "2026-09-22T00:00:01Z",
      ended_at: null,
    },
    participants: [
      { contact_id: "user", kind: "user", attached: true, track: "audio", muted: false, connected: true },
      { contact_id: "agent", kind: "agent", attached: true, track: "audio", muted: false, connected: true },
    ],
  } as unknown as CallRoomStateFrame;
  room.emit("roomState", state);
  transport.end();

  expect(statuses).toEqual(["in-progress"]);
  expect(room.sent.at(-1)).toEqual({ type: "end" });
  transport.close();
});

it("reports abnormal signaling closure without destroying the WebRTC peer", async () => {
  const room = new FakeRoom();
  const webRTC = new FakeWebRTC();
  const transport = makeTransport(room, webRTC);
  const closes: number[] = [];
  transport.on("close", (event) => closes.push(event.code));
  await connectTransport(transport, room);
  room.emit("close", { code: 1006, reason: "network", wasClean: false });
  expect(closes).toEqual([1006]);
  expect(webRTC.peer.closed).toBe(false);
  transport.close();
});
