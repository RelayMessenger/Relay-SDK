# `@relaymessenger/livekit`

`@relaymessenger/livekit` connects Relay Calls to TypeScript LiveKit Agents.
It translates audio and video between the Relay SDK's call transport
(`RelayCallTransport` from `@relaymessenger/sdk/calls`) and LiveKit
`AudioFrame` and `VideoFrame` objects. The transport owns the Node WebRTC peer, so application
code does not handle Cloudflare, SDP, ICE, or SFU credentials.

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

`RelayAudioOutput` has the shape of LiveKit's own `ParticipantAudioOutput`.
Like LiveKit's, it waits until the person is receiving the agent's audio: the
transport holds each frame until then, so a greeting that starts early is not
cut, sends silence meanwhile, and skips nothing. Then `captureFrame()` hands each
frame to the transport and returns at once, so the
AgentSession may push a whole reply faster than real time; the engine's 20 ms
pump paces the wire. `flush()` closes the segment and reports
`playbackFinished` only after the transport has drained. `clearBuffer()` drops
audio that has not reached the wire and reports the segment as interrupted at
the position that actually played.

## Text during a Call

Every Call belongs to a chat (`call.chat_id`). `relayChatTools(relay, chatId)`
gives the agent LiveKit `llm.tool`s that send to that chat while it talks, with
the same parts Relay's text agents send: `send_message`, `send_buttons`,
`send_selection`, `send_place`, `request_location`, `read_location` and
`send_link`. Each tool checks its arguments with the SDK's own part builders,
so a bad argument comes back to the model as an `llm.ToolError` instead of a
400 from the API.

`relayChatContext(relay, chatId, limit)` reads the chat's newest `limit`
Messages (20 by default) into an `llm.ChatContext`, oldest first: the agent's
own as `assistant`, the person's as `user`. A place, a location share or a
selection answer becomes data the model can read. Pass it as the Agent's
`chatCtx` so the call starts where the texting stopped.

```ts
import { voice } from "@livekit/agents";
import { relayChatContext, relayChatTools } from "@relaymessenger/livekit";

const agent = new voice.Agent({
  instructions: "You are a concierge. Text the person anything they should keep.",
  chatCtx: await relayChatContext(relay, call.chat_id),
  tools: relayChatTools(relay, call.chat_id),
});
```

To use only some of them, pick the keys you want:
`const { send_message, send_place } = relayChatTools(relay, call.chat_id)`.

## Video

The person's camera arrives as `@livekit/rtc-node` `VideoFrame`s (I420) on
`call.videoInput`. LiveKit Agents for Node has no `session.input.video`, so
read the frames yourself: keep `call.videoInput.latestFrame` for an
`llm.ImageContent` when the user's turn completes, or iterate
`call.videoInput` into a realtime model that takes video. A reader always gets
the newest frame; frames it did not read in time are replaced, not queued.
Nothing is decoded until the first read, so an agent that never looks pays
nothing for the camera, and iteration ends when the call does.

```ts
import { llm, voice } from "@livekit/agents";

class Assistant extends voice.Agent {
  override async onUserTurnCompleted(_chatCtx: llm.ChatContext, newMessage: llm.ChatMessage) {
    const frame = call.videoInput.latestFrame;
    if (frame) newMessage.content.push(llm.createImageContent({ image: frame }));
  }
}
```

To send the agent's own video, make a `VideoSource`, wrap it in a
`LocalVideoTrack` and publish it on the transport, with the same names as
LiveKit's `LocalParticipant.publishTrack`. `captureFrame` takes
`@livekit/rtc-node` frames; any layout the encoder does not take is converted
to I420 by LiveKit's own converter first.

```ts
import { VideoBufferType, VideoFrame } from "@livekit/rtc-node";
import { LocalVideoTrack, VideoSource } from "@relaymessenger/livekit";

const source = new VideoSource(640, 360);
const track = LocalVideoTrack.createVideoTrack("camera", source);
await call.transport.publishTrack(track, { videoEncoding: { maxFramerate: 15 } });
source.captureFrame(new VideoFrame(rgba, 640, 360, VideoBufferType.RGBA));
```

`new VideoStream(track)` reads any `RemoteVideoTrack` as LiveKit
`VideoFrameEvent`s. Video needs `node-webcodecs`, an optional dependency of
this package.

Use `setMuted(true)` to publish participant mute state, `end()` to end the Relay
Call, and `close()` for local cleanup. If the signaling connection is replaced,
`call.transport.reconnect()` keeps the existing media peer and replays the same
audio publication so Relay can return its cached answer.

`RelayLiveKitCall.connect()` accepts the transport's `iceServers`,
`iceTransportPolicy` and `sessionConnectTimeoutMs`; `call.waitForPeerAudio()`
and `call.diagnostics()` read the transport. Frame rates, ICE servers, restarts and
diagnostics are documented with the transport in the
[`@relaymessenger/sdk` README](https://github.com/RelayMessenger/Relay-SDK/tree/main/packages/sdk#join-a-call-as-the-agent).
`@livekit/agents` and `@livekit/rtc-node` are peer dependencies so the host
agent process owns those runtimes.

## Drive a Rive file

Instead of sending video, the agent can have the phone draw its own Rive file
(the `rive` on its profile). `RelayRive` has the shape of LiveKit's avatar
plugins, with the Relay call in place of the room:

```ts
import { RelayLiveKitCall, RelayRive } from "@relaymessenger/livekit";

const call = await RelayLiveKitCall.connect({ relay, callId });
call.attach(session);
const avatar = new RelayRive();
await avatar.start(session, call);
avatar.rive?.on("trigger", (name) => console.log("the person fired", name));
```

Each reply sets the View Model's `speaking` true at the moment its first
sample plays and false, with `viseme` 0, where its audio ends (at once when it
is interrupted).
Rename them with `speakingProperty` and `visemeProperty`, or pass `null`.
`avatar.rive` sets any other value, fires triggers and switches files; time a
value to speech with `{ at }` from the start `call.transport.writeAudio` resolves with.
Word-timed mouth shapes need the session's transcription output, whose
`TextOutput` class `@livekit/agents` 1.9 does not export; the Python
`relaymessenger-livekit` reads TTS-aligned words and sends them.
