# `@relaymessenger/livekit`

`@relaymessenger/livekit` connects Relay Calls to TypeScript LiveKit Agents.
Relay stays responsible for the Call resource and signaling; the package owns
the Node WebRTC peer and translates audio between Relay and LiveKit `AudioFrame`
objects, and sends and receives video with LiveKit's video API. Application code does not handle Cloudflare, SDP, ICE, or SFU
credentials.

Install it next to the Relay SDK and the LiveKit Agents runtime:

```sh
npm install @relaymessenger/sdk @relaymessenger/livekit \
  @livekit/agents @livekit/rtc-node
```

## Answer a Relay Call

Agents receive `call.created` through the normal Relay Webhook or acknowledged
Agent WebSocket. Joining that Call's authenticated room answers it; there is no
agent call URL or separate accept endpoint.

```ts
import { AgentSession } from "@livekit/agents";
import Relay from "@relaymessenger/sdk";
import { RelayLiveKitCall } from "@relaymessenger/livekit";

const relay = new Relay({ apiKey: process.env.RELAY_AGENT_TOKEN! });

async function answerCall(callId: string, session: AgentSession) {
  const call = await RelayLiveKitCall.connect({ relay, callId });
  call.attach(session);

  call.transport.on("ended", () => {
    void call.close();
  });

  return call;
}
```

`RelayLiveKitCall.connect()` does not resolve until the WebRTC media peer has
reached `connected`. `RelayAudioInput` hands the AgentSession the remote
participant's audio as 24 kHz mono PCM16 frames, the format of LiveKit's own
room input; the Opus decoder produces that format directly.

`RelayAudioOutput` has the shape of LiveKit's own `ParticipantAudioOutput`:
`captureFrame()` hands the frame to the transport and returns at once, so the
AgentSession may push a whole reply faster than real time; the engine's 20 ms
pump paces the wire. `flush()` closes the segment and reports
`playbackFinished` only after the transport has drained. `clearBuffer()` drops
audio that has not reached the wire and reports the segment as interrupted at
the position that actually played.

On the transport, `writeAudio()` resolves once its 10 ms slices are queued,
`queuedAudioMs()` is what has not left yet, and `waitForPlayout()` resolves when
the queue is empty and the pump is idle (early on `clearAudio()`).

Use `setMuted(true)` to publish participant mute state, `end()` to end the Relay
Call, and `close()` for local cleanup. If the signaling connection is replaced,
`call.transport.reconnect()` keeps the existing media peer and replays the same
audio publication so Relay can return its cached answer.

## Provider-neutral transport

The WebRTC/PCM layer is a separate public entry point for future adapters that
do not use LiveKit Agents:

```ts
import { RelayCallTransport } from "@relaymessenger/livekit/transport";

const room = relay.calls.room(callId);
const transport = new RelayCallTransport({ room });

transport.on("audio", ({ samples, sampleRate, channelCount }) => {
  // Interleaved signed PCM16 from the remote Relay participant.
});
// Inbound audio is 48 kHz stereo unless you pass
// `inboundAudio: { sampleRate: 8000 | 12000 | 16000 | 24000 | 48000, channelCount: 1 | 2 }`;
// the `"wrtc"` engine accepts only the default.

await transport.connect();
await transport.writeAudio({
  samples,
  sampleRate: 48_000,
  channelCount: 1,
});
await transport.waitForPlayout();
```

## Video

Relay calls carry video whenever a camera is on. The video API copies
LiveKit's `@livekit/rtc-node` names: `VideoSource`, `LocalVideoTrack`,
`VideoFrame`, `VideoBufferType`, `VideoStream`. Video needs the default
`"werift"` engine and the optional dependency `node-webcodecs` (prebuilt for
macOS arm64 and Linux x64/arm64).

Send a video feed:

```ts
import {
  LocalVideoTrack,
  VideoBufferType,
  VideoFrame,
  VideoSource,
} from "@relaymessenger/livekit/transport";

await transport.connect();

const source = new VideoSource(640, 480);
const track = LocalVideoTrack.createVideoTrack("camera", source);
await transport.publishTrack(track, {
  videoEncoding: { maxBitrate: 800_000, maxFramerate: 15 },
});

// RGBA, BGRA or I420 bytes, tightly packed.
source.captureFrame(new VideoFrame(rgba, 640, 480, VideoBufferType.RGBA));

// Camera off, then on again; the track stays negotiated.
await transport.unpublishTrack(track);
await transport.publishTrack(track);
```

Receive the other participant's video:

```ts
import { VideoBufferType, VideoStream } from "@relaymessenger/livekit/transport";

transport.on("trackSubscribed", async (track) => {
  const stream = new VideoStream(track, { format: VideoBufferType.RGBA, capacity: 2 });
  for await (const { frame, timestampUs } of stream) {
    // frame.data is width x height x 4 bytes of RGBA.
  }
});
transport.on("remoteVideo", (on) => {
  // The other participant's camera started or stopped sending.
});
```

Frames are decoded only while a `VideoStream` is open. `transport.videoStats()`
reports frames, packets, keyframes and decode errors in both directions.

## ICE servers, TURN, and diagnostics

By default the peer uses Cloudflare's STUN server
(`stun:stun.cloudflare.com:3478`), as Cloudflare's own Realtime echo example
does, and Cloudflare's SFU supplies its own candidates in the answer. The offer
leaves as soon as the first local candidate exists, without waiting for ICE
gathering to finish: the SFU is ICE-lite and learns the agent's address from
its connectivity checks. Inside a container or behind a firewall that
blocks outbound UDP, pass TURN servers in the standard `RTCIceServer` shape and,
if every path must go through TURN, `iceTransportPolicy: "relay"`. Both options
are accepted by `RelayLiveKitCall.connect()` and `RelayCallTransport`.

```ts
const call = await RelayLiveKitCall.connect({
  relay,
  callId,
  iceServers: [
    {
      urls: [
        "turn:turn.cloudflare.com:3478?transport=udp",
        "turn:turn.cloudflare.com:3478?transport=tcp",
        "turns:turn.cloudflare.com:5349?transport=tcp",
      ],
      username: process.env.TURN_USERNAME!,
      credential: process.env.TURN_CREDENTIAL!,
    },
  ],
  iceTransportPolicy: "all",
});
```

`iceServers` may also be a function; it is called before every peer
connection, so it can mint fresh TURN credentials for each restart.

`connect()` resolves when media first reaches `connected`. It has no overall
deadline: when an SFU session is not `connected` within
`sessionConnectTimeoutMs` (5 seconds by default) of its answer, becomes
`failed`, or stays `disconnected` for 7 seconds, the transport closes that
peer, waits 250 ms (x1.1 per further attempt, at most 10 s), and publishes
from a new peer on a new session, for as long as the Call is ringing or in
progress. Outgoing audio keeps flowing into the new peer. `connect()` rejects
only when the Call ends, the room or transport closes, the room reports an
error, or the `signal` passed to it aborts. Each replacement emits
`restarted` with the reason and the replaced session's summary, for example
`local: host 2, srflx 0, relay 0; remote: udp 1473; states: new→complete 0.2s, connecting 0.3s, no connected; …`,
and `diagnostics().restarts` counts them. `mediaConnectTimeoutMs` and
`connectionTimeoutMs` are deprecated names for `sessionConnectTimeoutMs`.

`call.waitForPeerAudio(timeoutMs)` resolves once the person's audio has
arrived and the room shows them connected (the transport's `peerAudio` event);
start the agent's session after it so the first words are heard.

The same facts are available at any time from `call.diagnostics()` or
`transport.diagnostics()`: local candidate counts by type, the remote
candidates' transport and port (never their address), the ICE gathering, ICE
connection and peer connection state changes with their offsets from
`connect()`, packet counts in both directions (`inbound`: RTP received, Opus
decode failures, PCM frames delivered, first and last packet offsets, packets
in the last 5 s; `outbound`: PCM frames accepted, Opus packets, RTP written
with the caller's audio, RTP written with silence, first and last packet
offsets, packets in the last 5 s, paced queue size, pacer state), the room frames seen (`roomState` count, pull `offer` count,
`ended` reason, `error` messages), and the one-line `summary`, for example
`…; in: 1234 rtp, 0 bad, 1234 frames, first 0.9s last 41.2s, 250/5s; out: 2600 frames, 1300 opus, 1300 rtp, silence 700, first 1.1s last 41.0s, 250/5s, queue 0, pacer alive; room: 3 roomState, 1 offer`.
Packet counts come from the `werift` engine; `wrtc` reports zero packets and
`pacer n/a`.

Like a live microphone, the `werift` engine's published track sends one Opus
packet every 20 ms from the moment media connects until the transport closes,
paced by the monotonic clock: a timer that fires late sends every packet due
by then, so the wire carries exactly 50 packets a second; a stall longer than
200 ms restarts the clock instead of bursting. The track carries
the caller's audio when some is queued, Opus silence otherwise. Cloudflare's
SFU will not let the person's side pull a track that has carried no RTP, so a
silent agent track would never be heard. Silence never counts toward
`queuedAudioMs()` or `waitForPlayout()`. The `wrtc` engine sends only the
audio written to it; write silence yourself if you use it.

`onWarning` is called once per call, with the summary, when outbound audio is
queued but no RTP packet has been written for 2 s while media is connected.
Nothing is restarted; the callback exists so the failing direction is named in
the agent's logs.

`RelayCallTransport` consumes the SDK's `CallRoom`; it does not duplicate the
room protocol. The default engine is `werift` (pure TypeScript WebRTC) with
`@evan/opus` (prebuilt Opus, WASM fallback), so no native WebRTC binding is
loaded. Pass `engine: "wrtc"` to use the optional `@roamhq/wrtc` binding
instead. The transport boundary remains provider-neutral for additional adapters. `@livekit/agents`
and `@livekit/rtc-node` are peer dependencies so the host agent process owns
those runtimes.
