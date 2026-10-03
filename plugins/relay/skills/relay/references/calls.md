# Calls

A Relay Call is a one-to-one voice or video call between a person and an
agent. Your agent joins the Call's room with its Agent Token; the SDK carries
WebRTC. Never handle SDP, ICE or SFU credentials yourself.

## Answer a call

Answer in the same process that texts: an agent has one event stream, and a
second process reading it takes events from the first. In `on_event` from
[build an agent](build-an-agent.md#text-over-the-websocket):

```python
calls: set[asyncio.Task] = set()  # keep references so tasks are not collected

# in on_event:
elif event["event_type"] == "call.created" and data["call"]["status"] == "ringing":
    task = asyncio.create_task(run_call(data["call"]["id"]))  # never await call work in on_event
    calls.add(task)
    task.add_done_callback(calls.discard)
```

Join within 32 seconds of `ringing`, or the Call ends `no-answer`; joining
answers it. A Call your agent places also arrives as `call.created`
(`from.kind: "agent"`), and joining it is the same. To decline, end it while
it rings: `await relay.calls.end(call_id)`.

### Bridge to a voice provider

Relay carries the audio; any provider hears, thinks and speaks. Pick the
docs page for how your providers connect, and follow it:

- Separate speech-to-text, model and voice, in any mix: Pipecat with
  `RelayTransport` (`uv add relaymessenger-pipecat "pipecat-ai[<your providers>]"`).
  https://docs.relayapp.im/integrations/pipecat.md
- LiveKit Agents: https://docs.relayapp.im/integrations/livekit.md
- A hosted conversational agent from a voice provider:
  https://docs.relayapp.im/calls/elevenlabs.md is the bridge pattern.
- Raw PCM in and out, for anything else: https://docs.relayapp.im/calls/audio.md

Pipecat has a streaming (WebSocket) and an HTTP class for most voices. If the
model the person named refuses the streaming connection (HTTP 400 on
connect), use the provider's HTTP class with the same model; do not switch
models. Test one spoken sentence with the exact model before wiring the call.

Every provider page lists its recipe. The index of all of them:
https://docs.relayapp.im/llms.txt (the Calls and Integrations sections). Runnable
bots: https://github.com/RelayMessenger/Relay-SDK/tree/main/cookbook. Copy a
bot's pipeline, not its own `run_websocket` loop: your process already has one.
Framework details: https://github.com/pipecat-ai/skills,
https://github.com/livekit/agent-skills.

The shape of `run_call` with Pipecat, video included:

```python
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.workers.runner import WorkerRunner
from relaymessenger_pipecat import RelayParams, RelayTransport

async def run_call(call_id: str) -> None:
    transport = RelayTransport(api_key=TOKEN, call_id=call_id, params=RelayParams(
        audio_in_enabled=True, audio_out_enabled=True,
        video_out_enabled=True, video_out_is_live=True,      # the agent's camera, below
        video_out_width=W, video_out_height=H, video_out_framerate=FPS,
    ))
    stt, llm, tts, user, assistant = ...  # your providers and context aggregators, from the cookbook
    worker = PipelineWorker(
        Pipeline([transport.input(), stt, user, llm, tts, LoopCamera(), transport.output(), assistant]),
        params=PipelineParams(audio_in_sample_rate=16_000, audio_out_sample_rate=24_000),
        cancel_on_idle_timeout=False,
    )

    @transport.event_handler("on_participant_left")
    async def _left(transport, participant_id, reason):
        await worker.cancel()

    runner = WorkerRunner(handle_sigint=False)
    await runner.add_workers(worker)
    await runner.run()
```

## The agent's camera

The agent's video is its own track. It shows on the person's phone whenever
the agent publishes one; the person's camera does not matter. Publish on every
call, voice or video. Any frame source works: looping video files, a live
avatar service, frames from a video API, or your own renderer.

Two looping clips, talking while the agent speaks and listening otherwise.
Pipecat tells you when the agent speaks with `BotStartedSpeakingFrame` and
`BotStoppedSpeakingFrame`; this processor sits right before `transport.output()`:

```python
import asyncio
from pipecat.frames.frames import (BotStartedSpeakingFrame, BotStoppedSpeakingFrame,
                                   CancelFrame, EndFrame, OutputImageRawFrame, StartFrame)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

W, H, FPS = 720, 1280, 15  # 9:16 fills a phone

class LoopCamera(FrameProcessor):
    def __init__(self, talking="talking.mp4", listening="listening.mp4"):
        super().__init__()
        self._files, self._speaking, self._task = (talking, listening), False, None

    async def process_frame(self, frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        await self.push_frame(frame, direction)
        if isinstance(frame, StartFrame):
            self._task = self.create_task(self._play())
        elif isinstance(frame, (EndFrame, CancelFrame)) and self._task:
            await self.cancel_task(self._task)
        elif isinstance(frame, BotStartedSpeakingFrame):
            self._speaking = True
        elif isinstance(frame, BotStoppedSpeakingFrame):
            self._speaking = False

    async def _play(self):
        # One ffmpeg per clip, looping in real time as raw RGB; sound dropped.
        players = [await asyncio.create_subprocess_exec(
            "ffmpeg", "-v", "error", "-stream_loop", "-1", "-re", "-i", f, "-an",
            "-vf", f"scale={W}:{H},fps={FPS}", "-pix_fmt", "rgb24", "-f", "rawvideo", "-",
            stdout=asyncio.subprocess.PIPE) for f in self._files]
        try:
            while True:
                talking, listening = [await p.stdout.readexactly(W * H * 3) for p in players]
                image = talking if self._speaking else listening
                await self.push_frame(OutputImageRawFrame(image=image, size=(W, H), format="RGB"))
        finally:
            for p in players:
                p.kill()
```

Until the first frame, a published track sends one black frame a second. Send
up to 1920x1080 in either orientation at up to 30 frames a second.

Without Pipecat, publish the track yourself after `connect()`:
`source = VideoSource(W, H)`, `await call.publish_track(LocalVideoTrack.create_video_track("camera", source))`,
then `source.capture_frame(RelayVideoFrame(W, H, "rgb24", image))` per frame
(TypeScript: `publishTrack`, `captureFrame`, plus the `node-webcodecs`
package). A live lip-synced avatar: https://docs.relayapp.im/calls/avatars.md.
Sending video and reading the person's camera:
https://docs.relayapp.im/calls/video.md.

## Call a person

When you finish setting up calls, call the agent's owner once so they can try
it: restart the agent with the call code, then ring the chat saved in
`owner.json` ([text the owner](build-an-agent.md#text-the-owner)). The agent
joins its own call through `call.created`, so the WebSocket must be running.

```python
owner = json.loads(OWNER.read_text())
me = await relay.me.retrieve()
if me["calls_enabled"]:
    await relay.calls.create(owner["chat_id"], to=[owner["handle"]], idempotency_key=f"call-owner-{int(time.time())}")
```

Run it once, from a short script, after the agent restarted. `POST
/v1/chats/{chatId}/calls` rings the person in a one-to-one Chat:

```bash
curl -sS -X POST "https://api.relayapp.im/v1/chats/$CHAT_ID/calls" \
  -H "Authorization: Bearer $RELAY_AGENT_TOKEN" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $KEY" -d '{"to":["<person handle>"]}'
```

`201` returns the Call with `status: "ringing"`. The agent must join it like an
incoming Call, so `run_websocket` must be running or start within the ring.
Failures: `403` code `2003` (the person has not added the agent, turned off
Allow Calls for it, or a block), `422` code `1005` (their app cannot take calls
yet), `503` code `3006` (calls are off: `calls_enabled` is false). A person on
another call gives status `busy`. Tell them in your own words, or text instead.

## Call events

`call.created`, `call.updated` and `call.ended` arrive on the agent's WebSocket
or Webhook. Each `data.call` has `id`, `chat_id`, `from`, `to`, `status`,
`revision`, `created_at`, `ringing_at`, `answered_at`, `ended_at`. `status` is
`ringing` or `in-progress` while live, then `completed`, `no-answer`,
`canceled`, `busy` or `failed`. Keep the highest `revision` per `call.id`.
Relay writes a system Message with `system_event.type: "call"` into the Chat;
do not reply to it. `relay.calls.retrieve`, `relay.calls.list` and
`relay.calls.end` read and end Calls. Details:
https://docs.relayapp.im/calls/events.md.

## Rive instead of video

A Rive file on the Contact Card (`rive: { attachment_id, artboard,
state_machine, view_model }`) is drawn by the phone whenever no agent video
arrives; the agent drives it with `await call.rive()`. Read
https://docs.relayapp.im/calls/rive.md before using it.
