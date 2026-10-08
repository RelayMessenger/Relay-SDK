# `relaymessenger-pipecat`

Answer a Relay Call with a Pipecat bot. `RelayTransport` joins the Call as the
agent: the caller's voice and camera come into your pipeline, and your bot's
audio and video go back into the Call.

```sh
pip install relaymessenger-pipecat
```

Python 3.11 or newer, with `pipecat-ai` 1.11 or newer. The media core is
`relaymessenger.calls` from the Relay SDK (`relaymessenger[calls]`); it uses only Relay's public API with the agent's
token, so your code never handles SDP, ICE, or SFU credentials.

## Answer a Call

Your agent receives `call.created` through a Relay webhook or the Agent
WebSocket. Build the transport from that Call's ID and run a pipeline, the
same way you would with Pipecat's LiveKit transport:

```python
import os

from pipecat.frames.frames import LLMRunFrame
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
    # stt, llm and tts are your Pipecat services; the aggregators hold the LLM context.
    worker = PipelineWorker(
        Pipeline([transport.input(), stt, user_aggregator, llm, tts, transport.output(), assistant_aggregator]),
        cancel_on_idle_timeout=False,  # a quiet call is still a call
    )

    @transport.event_handler("on_first_participant_joined")
    async def on_first_participant_joined(transport, participant_id):
        await worker.queue_frames([LLMRunFrame()])  # the model speaks first, in its own words

    @transport.event_handler("on_participant_left")
    async def on_participant_left(transport, participant_id, reason):
        await worker.cancel()

    runner = WorkerRunner()
    await runner.add_workers(worker)
    await runner.run()
```

Joining answers a ringing Call, so start the pipeline within the Call's
32-second ring. The pipeline starts once the agent has joined the Call's
room, while its media is still connecting, so the bot can start its greeting
on `on_call_state_updated` with `in-progress`; `on_connected` fires when
media connects. The bot's audio is held until the caller is receiving it,
so a greeting is heard from its first word. `on_first_participant_joined`
fires once the caller's audio reaches the agent. `transport.end()` ends the
Call for both sides.

## Text the person during a Call

`relay_chat_tools` gives the bot's LLM tools for the Call's chat, as
[Pipecat's function calling](https://docs.pipecat.ai/guides/learn/function-calling)
documents them: each is a `FunctionSchema` with its handler bundled, so you
list them in `LLMContext(tools=[...])` and the LLM service registers the
handlers itself. The tools are `send_message`, `send_buttons`, `send_selection`,
`send_place`, `request_location`, `read_location` and `send_link`. Each tool
sends with the Relay SDK and its part helpers, as the agent. A failed send goes
back to the model as `{"status": "failed", "error": ...}`, so the bot can say so.
`load_chat_context` reads the chat's recent messages as LLM context messages,
so the bot knows the chat before it speaks.

```python
import os

from pipecat.processors.aggregators.llm_context import LLMContext
from relaymessenger import Relay
from relaymessenger_pipecat import load_chat_context, relay_chat_tools

relay = Relay(api_key=os.environ["RELAY_AGENT_TOKEN"])
call = await relay.calls.retrieve(call_id)
chat_id = call["call"]["chat_id"]

context = LLMContext(
    messages=[{"role": "system", "content": "..."}, *await load_chat_context(relay, chat_id)],
    tools=relay_chat_tools(relay, chat_id),
)
```

## Send and receive video

Set `video_in_enabled=True` to receive the caller's camera as
`UserImageRawFrame`s in RGB. Set `video_out_enabled=True` to send
`OutputImageRawFrame`s in `RGB`, `RGBA`, `BGRA` or `ARGB`, sized by
`video_out_width` and `video_out_height`. The camera track is published with
the audio when the bot joins, and sends one black frame a second until the
bot's first image.

[`examples/echo_bot.py`](examples/echo_bot.py) is a complete bot. It waits for
the next Call on the Agent WebSocket, echoes the caller's voice back, and sends
a moving test pattern:

```sh
RELAY_AGENT_TOKEN=... uv run examples/echo_bot.py
```

## A talking avatar

`examples/simli_avatar_bot.py` is Pipecat's own Simli example on a Relay
Call: Deepgram, OpenAI and Cartesia make the voice, and Pipecat's
`SimliVideoService` turns it into the frames of a talking face, which
`RelayTransport` sends as the agent's camera.

```sh
uv run --with 'pipecat-ai[simli,deepgram,cartesia,openai,silero]' examples/simli_avatar_bot.py
```

## Drive a Rive file

Instead of sending video, the agent can have the phone draw its own Rive file
(the `rive` on its profile) and drive it live. Put `RelayRiveProcessor` right
after the TTS service: TTS word timestamps become a `viseme` number (Preston
Blair's ten mouths, 0 rest to 9 WQ) and the bot speaking frames a `speaking`
boolean on the file's View Model, each timed against the agent's audio so
the mouth moves when the words are heard.

```python
from relaymessenger_pipecat import RelayRiveProcessor

pipeline = Pipeline([transport.input(), stt, user_aggregator, llm, tts, RelayRiveProcessor(transport), transport.output(), assistant_aggregator])
```

Rename the properties with `viseme_property=` and `speaking_property=`, or pass
`None` to leave one alone. For anything else (a score, a mood, another
file), use the channel directly: `rive = await transport.call.rive()`, then
`rive.set(...)`, `rive.trigger(...)`, `rive.show(...)`, and
`rive.on("view_model" | "trigger", ...)` for what the person does in the file.
`examples/rive_bot.py` is the Simli example with the processor in place of
the video service.

## Use your own TURN servers

Pass `ice_servers` a list of `RTCIceServer` dicts, or an async function that
returns one per media attempt, so short-lived credentials are minted each
time. The example shows Cloudflare TURN.
