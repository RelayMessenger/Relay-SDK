import { expect, it } from "vitest";
import type { CallRoom, CallRoomEventMap, CallRoomIceServer, CallRoomStateFrame, Relay } from "@relaymessenger/sdk";
import {
  RelayCallTransport,
  type RelayAudioSinkLike,
  type RelayAudioSourceLike,
  type RelayMediaStreamTrackLike,
  type RelayPeerConnectionLike,
  type RelayWebRTCFactory,
} from "../src/transport.js";
import {
  LocalVideoTrack,
  type RelayVideoReceiverLike,
  type RelayVideoReceiverStats,
  type RelayVideoSenderLike,
  type RelayVideoSenderStats,
  type RemoteVideoTrack,
  VideoBufferType,
  VideoFrame,
  VideoSource,
  VideoStream,
} from "../src/video.js";

/**
 * The transport's video signaling against a fake room and fake engine:
 * the add-track offer and `userUpdate.video` of PROTOCOL.md section 2, a pull
 * offer that crosses the add-track offer, restarts, and the remote track.
 */

type RoomEvent = Extract<keyof CallRoomEventMap, string>;

class FakeRoom {
  readonly listeners = new Map<string, Set<(...args: any[]) => void>>();
  /** What Relay's room sends after `join` when it cannot mint TURN (PROTOCOL.md section 6). */
  iceServers: CallRoomIceServer[] | null = [{ urls: ["stun:stun.cloudflare.com:3478"] }];
  state: CallRoomStateFrame | null = null;
  readonly sent: any[] = [];
  async connect(): Promise<void> {}
  async reconnect(): Promise<void> {}
  send(frame: unknown): void { this.sent.push(structuredClone(frame)); }
  connected(): void { this.send({ type: "connected" }); }
  userUpdate(update: { muted: boolean; video?: boolean }): void { this.send({ type: "userUpdate", ...update }); }
  end(): void {}
  close(): void {}
  off<K extends RoomEvent>(event: K, listener: (...args: CallRoomEventMap[K]) => void): this {
    this.listeners.get(event)?.delete(listener as (...args: any[]) => void);
    return this;
  }
  on<K extends RoomEvent>(event: K, listener: (...args: CallRoomEventMap[K]) => void): this {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener as (...args: any[]) => void);
    this.listeners.set(event, listeners);
    return this;
  }
  emit<K extends RoomEvent>(event: K, ...args: CallRoomEventMap[K]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
  offers(): any[] { return this.sent.filter((frame) => frame.type === "offer"); }
}

class FakeTrack implements RelayMediaStreamTrackLike {
  constructor(readonly kind: string) {}
  stop(): void {}
}

class FakePeer implements RelayPeerConnectionLike {
  connectionState = "new";
  iceGatheringState = "complete";
  signalingState = "stable";
  localDescription: RTCSessionDescription | null = null;
  remoteDescription: RTCSessionDescription | null = null;
  onconnectionstatechange: (() => void) | null = null;
  ontrack: ((event: { track: RelayMediaStreamTrackLike; transceiver?: unknown }) => void) | null = null;
  readonly transceivers: Array<{ mid: string; track: RelayMediaStreamTrackLike }> = [];
  offers = 0;
  remoteOffers: string[] = [];
  addTransceiver(track: RelayMediaStreamTrackLike): { mid: string } {
    const transceiver = { mid: String(this.transceivers.length), track };
    this.transceivers.push(transceiver);
    return transceiver;
  }
  async createOffer(): Promise<RTCSessionDescriptionInit> {
    this.offers += 1;
    return { type: "offer", sdp: `offer-${this.offers}` };
  }
  async createAnswer(): Promise<RTCSessionDescriptionInit> { return { type: "answer", sdp: "answer-sdp" }; }
  async setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = description as RTCSessionDescription;
    this.signalingState = description.type === "answer" ? "stable" : "have-local-offer";
  }
  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = description as RTCSessionDescription;
    if (description.type === "offer") {
      this.remoteOffers.push(description.sdp!);
      this.signalingState = "have-remote-offer";
      return;
    }
    this.signalingState = "stable";
    if (this.connectionState !== "connected") {
      this.connectionState = "connected";
      queueMicrotask(() => this.onconnectionstatechange?.());
    }
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void { this.connectionState = "closed"; }
}

const senderStats = (): RelayVideoSenderStats => ({
  codec: "h264", framesCaptured: 0, framesEncoded: 0, framesDropped: 0, keyframes: 0, rtpPackets: 0, bytes: 0,
  keyframeRequests: 0, encodeErrors: 0, firstFrameAt: undefined, lastFrameAt: undefined, recentFrames: 0,
  width: undefined, height: undefined,
});

class FakeSender implements RelayVideoSenderLike {
  readonly track = new FakeTrack("video");
  readonly bound: Array<{ transceiver: unknown; peer: unknown }> = [];
  readonly captured: VideoFrame[] = [];
  enabled = true;
  closed = false;
  bind(transceiver: unknown, peer: unknown): void { this.bound.push({ transceiver, peer }); }
  capture(frame: VideoFrame): void { if (this.enabled) this.captured.push(frame); }
  setEnabled(enabled: boolean): void { this.enabled = enabled; }
  stats(): RelayVideoSenderStats { return senderStats(); }
  close(): void { this.closed = true; }
}

class FakeReceiver implements RelayVideoReceiverLike {
  onframe: RelayVideoReceiverLike["onframe"] = null;
  active = false;
  stopped = false;
  setActive(active: boolean): void { this.active = active; }
  stats(): RelayVideoReceiverStats {
    return {
      codec: "video/H264", rtpPackets: 3, framesAssembled: 1, framesDropped: 0, framesDecoded: 1, decodeErrors: 0,
      keyframeRequests: 1, firstFrameAt: 1, lastFrameAt: 2, recentFrames: 1, width: 2, height: 2,
    };
  }
  stop(): void { this.stopped = true; }
}

class FakeWebRTC implements RelayWebRTCFactory {
  readonly peers: FakePeer[] = [];
  readonly sender = new FakeSender();
  readonly receivers: FakeReceiver[] = [];
  createPeerConnection(): RelayPeerConnectionLike {
    const peer = new FakePeer();
    this.peers.push(peer);
    return peer;
  }
  createAudioSource(): RelayAudioSourceLike {
    return { createTrack: () => new FakeTrack("audio"), onData: () => undefined };
  }
  createAudioSink(): RelayAudioSinkLike { return { ondata: null, stop: () => undefined }; }
  async createVideoSender(): Promise<RelayVideoSenderLike> { return this.sender; }
  createVideoReceiver(): RelayVideoReceiverLike {
    const receiver = new FakeReceiver();
    this.receivers.push(receiver);
    return receiver;
  }
  get peer(): FakePeer { return this.peers.at(-1)!; }
}

const flush = async (): Promise<void> => {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
};
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const answer = (sdp: string) => ({ type: "answer" as const, session_description: { type: "answer" as const, sdp } });
const pull = (sdp: string, track: "audio" | "video") =>
  ({ type: "offer" as const, session_description: { type: "offer" as const, sdp }, track });

const connected = async () => {
  const room = new FakeRoom();
  const webRTC = new FakeWebRTC();
  const transport = new RelayCallTransport({
    relay: {} as Relay,
    callId: "01995bc0-0000-7000-8000-000000000002",
    roomClient: room as unknown as CallRoom,
    webRTC,
  });
  const connecting = transport.connect();
  await flush();
  room.emit("answer", answer("answer-1"));
  await connecting;
  return { room, webRTC, transport };
};

it("publishes the camera with an add-track offer listing audio and video, then announces video: true", async () => {
  const { room, webRTC, transport } = await connected();
  const source = new VideoSource(2, 2);
  const track = LocalVideoTrack.createVideoTrack("camera", source);
  const publishing = transport.publishTrack(track);
  await flush();
  expect(room.offers().at(-1)).toEqual({
    type: "offer",
    session_description: { type: "offer", sdp: "offer-2" },
    tracks: [{ mid: "0", name: "audio" }, { mid: "1", name: "video" }],
  });
  expect(webRTC.sender.bound).toEqual([{ transceiver: webRTC.peer.transceivers[1], peer: webRTC.peer }]);
  await publishing;
  expect(room.sent.at(-1)).toEqual({ type: "userUpdate", muted: false, video: true });

  // The pull offer for the person's camera crosses the add-track offer: it waits for the answer.
  room.emit("offer", pull("pull-video", "video"));
  await flush();
  expect(webRTC.peer.remoteOffers).toEqual([]);
  room.emit("answer", answer("answer-2"));
  await flush();
  expect(webRTC.peer.remoteDescription?.sdp).toBe("pull-video");
  expect(room.sent.at(-1)).toEqual(answer("answer-sdp"));

  const frame = new VideoFrame(new Uint8Array(6), 2, 2, VideoBufferType.I420);
  source.captureFrame(frame);
  expect(webRTC.sender.captured).toEqual([frame]);
  transport.close();
});

it("camera off keeps the track negotiated: unpublish announces video: false, publish again renegotiates nothing", async () => {
  const { room, webRTC, transport } = await connected();
  const track = LocalVideoTrack.createVideoTrack("camera", new VideoSource(2, 2));
  const publishing = transport.publishTrack(track);
  await flush();
  room.emit("answer", answer("answer-2"));
  await publishing;
  const offers = room.offers().length;
  transport.setMuted(true);
  await transport.unpublishTrack(track);
  expect(webRTC.sender.enabled).toBe(false);
  expect(room.sent.at(-1)).toEqual({ type: "userUpdate", muted: true, video: false });
  await transport.publishTrack(track);
  expect(webRTC.sender.enabled).toBe(true);
  expect(room.sent.at(-1)).toEqual({ type: "userUpdate", muted: true, video: true });
  expect(room.offers()).toHaveLength(offers);
  await expect(transport.publishTrack(LocalVideoTrack.createVideoTrack("other", new VideoSource(2, 2))))
    .rejects.toThrow("one video track");
  transport.close();
  expect(webRTC.sender.closed).toBe(true);
});

it("a restart re-publishes video on the new session and keeps one remote video track", async () => {
  const { room, webRTC, transport } = await connected();
  const subscribed: RemoteVideoTrack[] = [];
  const unsubscribed: RemoteVideoTrack[] = [];
  transport.on("trackSubscribed", (remote) => subscribed.push(remote));
  transport.on("trackUnsubscribed", (remote) => unsubscribed.push(remote));
  const publishing = transport.publishTrack(LocalVideoTrack.createVideoTrack("camera", new VideoSource(2, 2)));
  await flush();
  room.emit("answer", answer("answer-2"));
  await publishing;

  const first = webRTC.peer;
  const personCamera = new FakeTrack("video");
  first.ontrack?.({ track: personCamera, transceiver: {} });
  expect(subscribed).toHaveLength(1);
  // werift re-announces the same track on the next renegotiation: the receiver stays.
  first.ontrack?.({ track: personCamera, transceiver: {} });
  expect(webRTC.receivers).toHaveLength(1);
  const stream = new VideoStream(subscribed[0]!);
  const reader = stream.getReader();
  const read = reader.read();
  await flush();
  expect(webRTC.receivers[0]!.active).toBe(true);

  first.connectionState = "failed";
  first.onconnectionstatechange?.();
  await sleep(400);
  const second = webRTC.peer;
  expect(second).not.toBe(first);
  expect(webRTC.receivers[0]!.stopped).toBe(true);
  expect(room.offers().at(-1)).toEqual({
    type: "offer",
    session_description: { type: "offer", sdp: "offer-1" },
    tracks: [{ mid: "0", name: "audio" }, { mid: "1", name: "video" }],
    restart: true,
  });
  expect(webRTC.sender.bound.at(-1)).toEqual({ transceiver: second.transceivers[1], peer: second });

  room.emit("answer", answer("answer-3"));
  await flush();
  second.ontrack?.({ track: new FakeTrack("video"), transceiver: {} });
  expect(subscribed).toHaveLength(1);
  expect(webRTC.receivers[1]!.active).toBe(true);
  const frame = new VideoFrame(new Uint8Array(6), 2, 2, VideoBufferType.I420);
  webRTC.receivers[1]!.onframe?.({ frame, timestampUs: 5n, rotation: 0 });
  expect((await read).value?.timestampUs).toBe(5n);
  expect(transport.videoStats().inbound?.rtpPackets).toBe(6);

  transport.close();
  expect(unsubscribed).toEqual(subscribed);
  expect((await reader.read()).done).toBe(true);
});

it("refuses to publish video before media connects and on an engine without video", async () => {
  const room = new FakeRoom();
  const webRTC = new FakeWebRTC();
  const transport = new RelayCallTransport({
    relay: {} as Relay,
    callId: "01995bc0-0000-7000-8000-000000000003",
    roomClient: room as unknown as CallRoom,
    webRTC,
  });
  const track = LocalVideoTrack.createVideoTrack("camera", new VideoSource(2, 2));
  await expect(transport.publishTrack(track)).rejects.toThrow("not connected");
  transport.close();

  const { transport: audioOnly } = await (async () => {
    const r = new FakeRoom();
    const w = new FakeWebRTC() as Partial<FakeWebRTC>;
    delete (w as { createVideoSender?: unknown }).createVideoSender;
    Object.defineProperty(w, "createVideoSender", { value: undefined });
    const t = new RelayCallTransport({
      relay: {} as Relay,
      callId: "01995bc0-0000-7000-8000-000000000004",
      roomClient: r as unknown as CallRoom,
      webRTC: w as RelayWebRTCFactory,
    });
    const connecting = t.connect();
    await flush();
    r.emit("answer", answer("answer-1"));
    await connecting;
    return { transport: t };
  })();
  await expect(audioOnly.publishTrack(track)).rejects.toThrow("cannot send video");
  audioOnly.close();
});
