# `relaymessenger-pipecat`

Answer a Relay Call with a Pipecat bot. `RelayTransport` joins the Call as the
agent: the caller's voice and camera come into your pipeline, and your bot's
audio and video go back into the Call.

```sh
pip install relaymessenger-pipecat
```

Python 3.11 or newer, with `pipecat-ai` 1.11 or newer. The media core is
`relaymessenger-calls`; it uses only Relay's public API with the agent's
token, so your code never handles SDP, ICE, or SFU credentials.

## Answer a Call

Your agent receives `call.created` through a Relay webhook or the Agent
WebSocket. Build the transport from that Call's ID and run a pipeline, the
same way you would with Pipecat's LiveKit transport:

```python
import os

from pipecat.frames.frames import TTSSpeakFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineWorker
from pipecat.workers.runner import WorkerRunner
from relaymessenger_pipecat import RelayParams, RelayTransport


async def answer(call_id: str) -> None:
    transport = RelayTransport(
        api_key=os.environ["RELAY_AGENT_TOKEN"],
        call_id=call_id,
        params=RelayParams(audio_in_enabled=True, audio_out_enabled=True),
    )
    # stt, llm and tts are your Pipecat services.
    worker = PipelineWorker(Pipeline([transport.input(), stt, llm, tts, transport.output()]))

    @transport.event_handler("on_first_participant_joined")
    async def on_first_participant_joined(transport, participant_id):
        await worker.queue_frame(TTSSpeakFrame("Hello! How can I help?"))

    @transport.event_handler("on_participant_left")
    async def on_participant_left(transport, participant_id, reason):
        await worker.cancel()

    runner = WorkerRunner()
    await runner.add_workers(worker)
    await runner.run()
```

Joining answers a ringing Call, so start the pipeline within the Call's
ten-second ring. `on_first_participant_joined` fires once the caller's audio
reaches the agent, so a greeting is heard. `transport.end()` ends the Call for
both sides.

## Send and receive video

Set `video_in_enabled=True` to receive the caller's camera as
`UserImageRawFrame`s in RGB. Set `video_out_enabled=True` to send
`OutputImageRawFrame`s in `RGB`, `RGBA`, `BGRA` or `ARGB`, sized by
`video_out_width` and `video_out_height`. The camera track is published once
the caller has joined.

[`examples/echo_bot.py`](examples/echo_bot.py) is a complete bot. It waits for
the next Call on the Agent WebSocket, echoes the caller's voice back, and sends
a moving test pattern:

```sh
RELAY_AGENT_TOKEN=... uv run examples/echo_bot.py
```

## Use your own TURN servers

Pass `ice_servers` a list of `RTCIceServer` dicts, or an async function that
returns one per media attempt, so short-lived credentials are minted each
time. The example shows Cloudflare TURN.
