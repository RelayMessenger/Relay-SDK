# Calls

A Relay Call is a one-to-one voice or video call between a person and an
agent. Your agent joins the Call's room with its Agent Token; the SDK carries
WebRTC. Never handle SDP, ICE or SFU credentials yourself.

## Answer a call

Answer in the same process that texts. An agent has one event stream, and two
consumers of it (a texting process and a separate call process) take events
from each other. Handle `call.created` next to `message.received`:

```typescript
// Inside relay.websocket.run({ onEvent }) from build-an-agent.md.
if (event.event_type === "call.created" && event.data.call.status === "ringing") {
  void answer(event.data.call.id); // never await call work inside onEvent
}
```

Join within 32 seconds of `ringing`, or the Call ends `no-answer`. Joining
answers it. To decline, `relay.calls.end(callId)` while it rings. A Call your
agent places also arrives as `call.created` (`from.kind: "agent"`), and your
agent joins it the same way.

The transport gives you the person's voice as PCM and plays yours:

```typescript
import { RelayCallTransport } from "@relaymessenger/sdk/calls";
// npm install @relaymessenger/sdk werift @evan/opus rtp-packet node-webcodecs

async function answer(callId: string): Promise<void> {
  const transport = new RelayCallTransport({ relay, callId });
  transport.on("audio", ({ samples, sampleRate, channelCount }) => {
    // The person's voice: interleaved PCM16, 48 kHz stereo by default. Send it to your speech-to-text.
  });
  transport.on("ended", () => transport.close());
  await transport.connect(); // resolves once media is connected
  // Your voice: transport.writeAudio({ samples: Int16Array, sampleRate, channelCount })
  // Barge-in: transport.clearAudio(). Hang up: transport.end().
}
```

Python (`pip install 'relaymessenger[calls]'`) has the same transport:
`RelayCallTransport(api_key=..., call_id=...)`, `@call.on("audio")`,
`await call.connect()`, `await call.write_audio(RelayAudioFrame(...))`.

### Bridge to a voice provider

Relay carries audio; your provider hears, thinks and speaks. Pick the path
that already has your providers, and write the whole agent (texting and calls)
in that language:

| Your providers | Path | Read |
| --- | --- | --- |
| Separate speech-to-text, LLM and voice (any mix) | Python, Pipecat `RelayTransport` | https://docs.relayapp.im/integrations/pipecat.md |
| An ElevenLabs Agent runs the whole conversation | TypeScript `@relaymessenger/elevenlabs` | https://docs.relayapp.im/calls/elevenlabs.md |
| LiveKit Agents | Python or TypeScript `relaymessenger-livekit` | https://docs.relayapp.im/integrations/livekit.md |
| A realtime speech-to-speech model | Pipecat, or the raw transport above | https://docs.relayapp.im/calls/audio.md |

Runnable bots: https://github.com/RelayMessenger/Relay-SDK/tree/main/cookbook
(`elevenlabs-voice-agent`, `elevenlabs-agents-call`, `grok-voice-agent`). They
run their own WebSocket loop; when you copy one, move its pipeline into your
one process and keep your single `onEvent`. For framework details read the
frameworks' own skills: https://github.com/pipecat-ai/skills,
https://github.com/livekit/agent-skills.

Pipecat: pass `call_id` and the Agent Token to `RelayTransport`; its `call`
property is the Relay transport once connected. `ElevenLabsCall` exposes it as
`call.transport`.

## The agent's camera

Your agent's video is its own track. It shows on the person's phone whenever
your agent publishes a track; the person's camera does not matter. Publish on
every call, voice or video. `publishTrack` announces it (`userUpdate
{ video: true }`); `unpublishTrack` turns it off.

Any frame source works: looping video files, a live avatar service, frames
from a video API, or your own renderer. The phone shows the frames you
capture, at the rate you capture them. Size 720x1280 (9:16) fills a phone.

Two looping clips, one while the agent speaks and one while it listens:

```typescript
import { spawnSync } from "node:child_process";
import { LocalVideoTrack, VideoBufferType, VideoFrame, VideoSource } from "@relaymessenger/sdk/calls";

const W = 720, H = 1280, FPS = 15, SIZE = (W * H * 3) / 2;

// Decode once at startup: I420 frames, scaled to the call size, sound dropped.
function frames(file: string): Uint8Array[] {
  const out = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-an", "-vf", `scale=${W}:${H},fps=${FPS}`,
    "-pix_fmt", "yuv420p", "-f", "rawvideo", "-"], { maxBuffer: 1 << 30 });
  if (out.status !== 0) throw new Error(String(out.stderr));
  const list: Uint8Array[] = [];
  for (let at = 0; at + SIZE <= out.stdout.length; at += SIZE) list.push(out.stdout.subarray(at, at + SIZE));
  return list;
}
const talking = frames("talking.mp4");
const listening = frames("listening.mp4");

// After transport.connect():
async function camera(transport: RelayCallTransport): Promise<void> {
  const source = new VideoSource(W, H);
  await transport.publishTrack(LocalVideoTrack.createVideoTrack("camera", source),
    { videoEncoding: { maxFramerate: FPS } });
  let index = 0, spokeAt = 0;
  const timer = setInterval(() => {
    if (transport.queuedAudioMs() > 0) spokeAt = Date.now(); // the agent's voice is playing
    const clip = Date.now() - spokeAt < 300 ? talking : listening;
    source.captureFrame(new VideoFrame(clip[index++ % clip.length], W, H, VideoBufferType.I420));
  }, 1000 / FPS);
  transport.on("ended", () => clearInterval(timer)).on("close", () => clearInterval(timer));
}
```

In Python the names are snake case: `VideoSource(W, H)`,
`await call.publish_track(LocalVideoTrack.create_video_track("camera", source))`,
`source.capture_frame(RelayVideoFrame(W, H, "i420", data))`, run from an
asyncio task you cancel when the call ends. In Pipecat, start it in
`on_first_participant_joined` with `transport.call`, and take speech from
Pipecat's own signal: a processor after `transport.output()` that sees
`BotStartedSpeakingFrame` and `BotStoppedSpeakingFrame`.

Until the first frame, a published track sends one black frame a second. Send
up to 1920x1080 (either orientation) at 30 frames a second. TypeScript video
needs `node-webcodecs`. A live lip-synced avatar: https://docs.relayapp.im/calls/avatars.md.
More on sending and reading video: https://docs.relayapp.im/calls/video.md.

### The person's camera

```typescript
import { VideoStream } from "@relaymessenger/sdk/calls";
transport.on("trackSubscribed", async (track) => {
  for await (const { frame } of new VideoStream(track, { capacity: 2, format: VideoBufferType.RGBA })) {
    // frame.data, frame.width, frame.height: give the newest to a vision model.
  }
});
transport.on("remoteVideo", (on) => { /* the person's camera turned on or off */ });
```

## Call a person

`POST /v1/chats/{chatId}/calls` rings the person in a one-to-one Chat. To call
the owner, use the `chat_id` returned when you [texted the owner](build-an-agent.md#text-the-owner):

```typescript
const me = await relay.me.retrieve();
if (me.calls_enabled) {
  const { call } = await relay.calls.create(
    ownerChatId,
    { to: [me.owner_people[0].handle] },
    { idempotencyKey: `call-owner-${ownerChatId}-${startedAt}` }, // reuse it on an uncertain retry
  );
  // call.created arrives with from.kind "agent": join call.id with the same answer() path.
}
```

```bash
curl -sS -X POST "https://api.relayapp.im/v1/chats/$CHAT_ID/calls" \
  -H "Authorization: Bearer $RELAY_AGENT_TOKEN" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $KEY" -d '{"to":["<person handle>"]}'
```

`201` returns the Call with `status: "ringing"`. Join its room as for an
incoming Call; the person answers on their phone. Failures: `403` code `2003`
(the person has not added the agent, turned off Allow Calls for it, or a block),
`422` code `1005` (their app cannot take calls yet), `503` code `3006` (calls
are off; `calls_enabled` is false). A person already on a call gives status
`busy`. Tell the person in your own words, or text instead.

## Call events

`call.created`, `call.updated` and `call.ended` arrive on the agent's
WebSocket or Webhook. Each `data.call` has `id`, `chat_id`, `from`, `to`,
`status`, `revision`, `created_at`, `ringing_at`, `answered_at`, `ended_at`.
`status` is `ringing` or `in-progress` while live, then `completed`,
`no-answer`, `canceled`, `busy` or `failed`. Keep the highest `revision` per
`call.id`. Relay also writes a system Message with `system_event.type: "call"`
into the Chat; do not reply to it. `relay.calls.retrieve(callId)`,
`relay.calls.list(chatId)` and `relay.calls.end(callId)` read and end Calls.

## Rive instead of video

A Rive file on the Contact Card (`rive: { attachment_id, artboard,
state_machine, view_model }`) is drawn by the phone whenever no agent video
arrives; drive it live with `await transport.rive()` (`set`, `trigger`,
`show`). Read https://docs.relayapp.im/calls/rive.md before using it.
