# `@relaymessenger/livekit`

`@relaymessenger/livekit` connects Relay Calls to TypeScript LiveKit Agents.
It translates audio between the Relay SDK's call transport
(`RelayCallTransport` from `@relaymessenger/sdk/calls`) and LiveKit
`AudioFrame` objects. The transport owns the Node WebRTC peer, so application
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

Use `setMuted(true)` to publish participant mute state, `end()` to end the Relay
Call, and `close()` for local cleanup. If the signaling connection is replaced,
`call.transport.reconnect()` keeps the existing media peer and replays the same
audio publication so Relay can return its cached answer.

`RelayLiveKitCall.connect()` accepts the transport's `iceServers`,
`iceTransportPolicy` and `sessionConnectTimeoutMs`; `call.waitForPeerAudio()`
and `call.diagnostics()` read the transport. Video, ICE servers, restarts and
diagnostics are documented with the transport in the
[`@relaymessenger/sdk` README](https://github.com/RelayMessenger/Relay-SDK/tree/main/packages/sdk#join-a-call-as-the-agent).
`@livekit/agents` and `@livekit/rtc-node` are peer dependencies so the host
agent process owns those runtimes.
