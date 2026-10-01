# Calls

A Relay Call is a one-to-one call in an individual Chat: audio, plus video
both ways. The Call resource and its events use REST and the normal
event delivery path. Media travels over WebRTC; the room WebSocket at
`GET /v1/calls/{callId}/room` carries only signaling. Use the SDK transports;
never handle SDP, ICE, or SFU credentials in application code.

Before offering a Call, read `GET /v1/me` (`relay.me.retrieve()`): when
`calls_enabled` is false, `calls.create` fails with 503, error code `3006`.

## Call events

`call.created`, `call.updated` and `call.ended` arrive on the agent's existing
Webhook or WebSocket path; an agent registers nothing for Calls. Each `data` is
one `call` object: `id`, `chat_id`, `from`, `to` (one recipient), `status`,
`revision`, `created_at`, `ringing_at`, `answered_at`, `ended_at`.

- `call.created` fires with `status: "ringing"` when a person calls the agent
  and when the agent's own Call is created.
- `call.updated` fires on a change that does not end the Call, such as
  `ringing` to `in-progress`.
- `call.ended` fires once with a terminal status.

`status` is `ringing` or `in-progress` while live, then one of `completed`,
`no-answer`, `canceled`, `busy` or `failed`, which set `ended_at`. Keep the
snapshot with the highest `revision` per `call.id` and drop older or duplicate
envelopes. Relay also writes one system Message with `system_event.type:
"call"` into the Chat; do not reply to it.

## Answer, place, and end a Call

Joining the room answers. Join within 32 seconds of `ringing`, or the Call
ends `no-answer`. To decline, end it while it rings.

```bash
npm install @relaymessenger/sdk@staging werift @evan/opus rtp-packet
```

```typescript
import Relay from "@relaymessenger/sdk";
import { RelayCallTransport } from "@relaymessenger/sdk/calls";

const relay = new Relay({ apiKey: process.env.RELAY_AGENT_TOKEN! });

// In the call.created handler, after the event is durably accepted.
async function answer(callId: string): Promise<RelayCallTransport> {
  const transport = new RelayCallTransport({ relay, callId });
  transport.on("audio", ({ samples, sampleRate, channelCount }) => {
    // The person's voice: interleaved PCM16, 48 kHz stereo by default.
  });
  transport.on("ended", () => transport.close());
  await transport.connect(); // resolves once media is connected
  await transport.writeAudio({ samples: new Int16Array(480), sampleRate: 48_000, channelCount: 1 });
  return transport;
}

// Decline a ringing Call, or end an answered one.
async function hangUp(callId: string): Promise<void> {
  await relay.calls.end(callId);
}
```

`writeAudio()` queues speech; audio written before the person can hear it
waits, so a greeting is heard whole. `clearAudio()` drops queued audio for
barge-in, `setMuted()` publishes mute state, `end()` ends the Call for both
sides, and `close()` cleans up locally without ending it.

To call a person, use a one-to-one Chat. The person must have added the agent
and left Allow Calls on; otherwise Relay answers 403 with error code `2003`
and places no Call. Reuse the `Idempotency-Key` after an uncertain response,
then join the room as for an incoming Call.

```typescript
const { call } = await relay.calls.create(
  chatId,
  { to: [personHandle] },
  { idempotencyKey: savedOperation.idempotencyKey },
);
```

`relay.calls.retrieve(callId)` reads one Call and `relay.calls.list(chatId)`
lists a Chat's Calls. In Python:

```python
call = await relay.calls.create(chat_id, to=[person_handle], idempotency_key=saved_key)
await relay.calls.retrieve(call["call"]["id"])
await relay.calls.list(chat_id, limit=20)
await relay.calls.end(call["call"]["id"])
```

Python (`pip install 'relaymessenger[calls]'`) has the same transport:

```python
import os

import numpy as np
from relaymessenger.calls import RelayAudioFrame, RelayCallTransport


async def answer(call_id: str) -> RelayCallTransport:
    call = RelayCallTransport(api_key=os.environ["RELAY_AGENT_TOKEN"], call_id=call_id)

    @call.on("audio")
    def _heard(frame: RelayAudioFrame) -> None:
        ...  # frame.samples, frame.sample_rate, frame.channel_count

    await call.connect()
    await call.write_audio(RelayAudioFrame(np.zeros(480, dtype=np.int16), 48_000, 1))
    return call
```

## Video

Both sides may send a camera. The transport publishes one `video` track and
announces it with the room's `userUpdate { video: true }`. Use LiveKit's names:
`VideoSource`, `LocalVideoTrack.createVideoTrack`, `publishTrack`,
`trackSubscribed`, `VideoStream`. TypeScript video needs the `werift` engine
(the default) and `node-webcodecs`.

```typescript
import {
  LocalVideoTrack, VideoBufferType, VideoFrame, VideoSource, VideoStream,
} from "@relaymessenger/sdk/calls";

// Send: publish after connect(), then capture frames at the rate you render.
const source = new VideoSource(1280, 720);
const camera = LocalVideoTrack.createVideoTrack("camera", source);
await transport.publishTrack(camera, { videoEncoding: { maxFramerate: 30 } });
source.captureFrame(new VideoFrame(rgba, 1280, 720, VideoBufferType.RGBA));
await transport.unpublishTrack(camera); // camera off; publishTrack(camera) resumes

// Receive: the person's camera, once per Call.
transport.on("trackSubscribed", async (track) => {
  for await (const { frame } of new VideoStream(track, { capacity: 2, format: VideoBufferType.RGBA })) {
    // frame.data, frame.width, frame.height
  }
});
transport.on("remoteVideo", (on) => {
  // The person's camera started (true) or stopped (false).
});
```

Send up to 1920x1080 at 30 frames a second. Without `videoEncoding`, each
frame size gets LiveKit's camera preset: 30 fps from 1280x720 (960x720 at
4:3) up, 25 fps at 960x540, 20 fps below that. `maxFramerate` and `maxBitrate` override it. The
codec is H.264 by default, VP8 offered second.

Python uses the same names in snake case:

```python
from relaymessenger.calls import (
    LocalVideoTrack, RelayVideoFrame, TrackPublishOptions, VideoEncoding, VideoSource, VideoStream,
)

source = VideoSource(1280, 720)
await call.publish_track(
    LocalVideoTrack.create_video_track("camera", source),
    TrackPublishOptions(video_encoding=VideoEncoding(max_framerate=30)),
)
source.capture_frame(RelayVideoFrame(1280, 720, "rgb24", rgb_bytes))


@call.on("track_subscribed")
def _camera(track) -> None:
    async def read() -> None:
        async for event in VideoStream(track, capacity=2):
            rgb = event.frame.convert("rgb24")
```

Until the first frame, a published camera sends one black frame a second.

## Rive

Instead of video, an agent can name a Rive file on its Contact Card
(`rive: { attachment_id, artboard, state_machine, view_model }` after an
Attachments upload, at most 10 MB, assets embedded; `rive: null` removes it).
The phone draws it whenever no agent video arrives, and the agent drives it
through data binding on the call's `rive` data channel:

```typescript
import { visemesFromAlignment } from "@relaymessenger/sdk/calls";

const rive = await transport.rive(); // after connect(); same handle on every call
rive.set({ mood: "happy" });          // View Model properties, applied at once
rive.trigger("wave");                  // a trigger property
rive.show({ file: card.rive!.file, artboard: "Quiz", view_model: { question: "2+2?" } });
rive.on("view_model", (values) => {}); // what the person changed in the file
rive.on("trigger", (name) => {});

// Time a change to speech: audio-track milliseconds, read before writeAudio.
const at = transport.audioTimeMs();
await transport.writeAudio(frame);
for (const cue of visemesFromAlignment(alignment)) rive.set({ viseme: cue.viseme }, { at: at + cue.t });
```

Python: `await call.rive()`, `rive.set(values, at=...)`, `call.audio_time_ms()`,
`visemes_from_alignment`. Pipecat: `RelayRiveProcessor(transport)` right after
TTS. LiveKit: `await RelayRive().start(session, call)`. Messages are JSON of at
most 1 KB on an unordered, lossy channel; each overwrites what it sets. If Relay
refuses the channel, `rive()` rejects with `media_unavailable` and the call
goes on.

## Voice frameworks

Relay publishes transports for the two common voice-agent frameworks. Each
answers the Call by joining its room with the Agent Token.

- Pipecat, Python: `pip install relaymessenger-pipecat`. `RelayTransport`
  plays the role of Pipecat's LiveKit transport. `RelayParams` takes
  Pipecat's `TransportParams`: `video_in_enabled` delivers the caller's camera
  as `UserImageRawFrame`, `video_out_enabled` sends `OutputImageRawFrame`
  sized by `video_out_width` and `video_out_height`.
- LiveKit Agents, Python: `pip install relaymessenger-livekit`.
  `RelayLiveKitCall.connect(api_key=..., call_id=...)`, then
  `call.attach(session)` wires audio in, audio out and the caller's camera
  into an `AgentSession`.
- LiveKit Agents, TypeScript: `npm install @relaymessenger/livekit
  @livekit/agents @livekit/rtc-node` (and `node-webcodecs` for video).
  `RelayLiveKitCall.connect({ relay, callId })`, then `call.attach(session)`
  for audio. LiveKit Agents for Node has no `session.input.video`, so the
  caller's camera arrives as `@livekit/rtc-node` I420 `VideoFrame`s on
  `call.videoInput`: read `call.videoInput.latestFrame` when a turn completes,
  or iterate `call.videoInput`. Nothing is decoded until the first read, so
  the first `latestFrame` is usually `undefined`; read it once right after
  connecting to start decoding. A reader always gets the newest frame, and
  iterating ends when the call's video ends.

```typescript
import { llm, voice } from "@livekit/agents";
import { VideoBufferType, VideoFrame } from "@livekit/rtc-node";
import { LocalVideoTrack, RelayLiveKitCall, VideoSource } from "@relaymessenger/livekit";

const call = await RelayLiveKitCall.connect({ relay, callId });
void call.videoInput.latestFrame; // the first read starts decoding the camera

class Assistant extends voice.Agent {
  override async onUserTurnCompleted(_chatCtx: llm.ChatContext, newMessage: llm.ChatMessage) {
    const frame = call.videoInput.latestFrame;
    if (frame) newMessage.content.push(llm.createImageContent({ image: frame }));
  }
}

// The agent's own camera, with LiveKit's names.
const source = new VideoSource(640, 360);
await call.transport.publishTrack(LocalVideoTrack.createVideoTrack("camera", source), {
  videoEncoding: { maxFramerate: 15 },
});
source.captureFrame(new VideoFrame(rgba, 640, 360, VideoBufferType.RGBA));
```

A Pipecat bot with a talking avatar uses Pipecat's own Simli service between
the TTS and the Relay output (`pip install relaymessenger-pipecat
"pipecat-ai[simli]"`; Pipecat's own Simli example sends 512x512 frames):

```python
import os

from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineWorker
from pipecat.services.simli.video import SimliVideoService
from relaymessenger_pipecat import RelayParams, RelayTransport


def avatar_bot(call_id: str, stt, user_aggregator, llm, tts, assistant_aggregator) -> PipelineWorker:
    transport = RelayTransport(
        api_key=os.environ["RELAY_AGENT_TOKEN"],
        call_id=call_id,
        params=RelayParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            video_out_enabled=True,
            video_out_is_live=True,
            video_out_width=512,
            video_out_height=512,
        ),
    )
    simli = SimliVideoService(api_key=os.environ["SIMLI_API_KEY"], face_id=os.environ["SIMLI_FACE_ID"])
    return PipelineWorker(Pipeline([
        transport.input(), stt, user_aggregator, llm, tts, simli, transport.output(), assistant_aggregator,
    ]))
```

Start the pipeline within the 32-second ring. Whole, runnable bots ship in the
packages: `python/relaymessenger-pipecat/examples/simli_avatar_bot.py` (run
with `uv run --with 'pipecat-ai[simli,deepgram,cartesia,openai,silero]'`) and
`python/relaymessenger-livekit/examples/gemini_live_video_agent.py` (Gemini
Live sees the caller's camera; `uv run --with 'livekit-agents[google]'`). For framework guidance, read
the frameworks' own published skills and docs, not copies:

- Pipecat skills: https://github.com/pipecat-ai/skills
- LiveKit agent skills: https://github.com/livekit/agent-skills
- LiveKit docs MCP server: https://docs.livekit.io/mcp
