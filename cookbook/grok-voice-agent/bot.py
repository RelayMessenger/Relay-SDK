"""Answer a Relay Call with xAI's Grok Voice Agent API: one speech-to-speech model, no separate STT or TTS.

    RELAY_AGENT_TOKEN=... XAI_API_KEY=... uv run bot.py

The bot waits on the Agent WebSocket for ``call.created``, joins that Call with
`RelayTransport` (joining answers it) and connects the caller's audio to
Pipecat's `GrokRealtimeLLMService` (wss://api.x.ai/v1/realtime). Grok hears the
caller, detects their turns, and speaks back into the Call. XAI_VOICE picks one of
xAI's voices (GET https://api.x.ai/v1/tts/voices); RELAY_BASE_URL selects another
Relay API origin.
"""

import asyncio
import json
import os
import sys

import websockets
from loguru import logger
from pipecat.frames.frames import LLMRunFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import LLMContextAggregatorPair
from pipecat.services.xai.realtime import events
from pipecat.services.xai.realtime.llm import GrokRealtimeLLMService
from pipecat.workers.runner import WorkerRunner

from relaymessenger_pipecat import RelayParams, RelayTransport

BASE_URL = os.environ.get("RELAY_BASE_URL", "https://api.relayapp.im")
PERSONA = os.environ.get(
    "AGENT_PERSONA",
    "You are Diego, a chubby, fast-talking squirrel who lives on the University of Michigan Diag. "
    "You are on a voice call: answer in one or two short spoken sentences. "
    "You love acorns, campus gossip and helping students find their way.",
)


async def next_call(token: str) -> str:
    """The ID of the next ``call.created`` on the Agent WebSocket, acknowledging every event."""
    url = BASE_URL.replace("https://", "wss://", 1) + "/v1/websocket"
    async with websockets.connect(url, additional_headers={"Authorization": f"Bearer {token}"}) as ws:
        async for raw in ws:
            frame = json.loads(raw)
            if frame["type"] == "full_sync":
                await ws.send(json.dumps({"type": "full_sync_complete", "through_sequence": frame["through_sequence"]}))
            if frame["type"] != "event":
                continue
            await ws.send(json.dumps({"type": "ack", "through_sequence": frame["sequence"]}))
            event = frame["event"]
            if event["event_type"] == "call.created":
                return str(event["data"]["call"]["id"])
    raise RuntimeError("The Agent WebSocket closed before a call arrived.")


async def main() -> None:
    token = os.environ["RELAY_AGENT_TOKEN"]
    logger.info("Waiting for a call")
    call_id = await next_call(token)
    logger.info(f"Answering call {call_id}")

    transport = RelayTransport(
        api_key=token,
        call_id=call_id,
        base_url=BASE_URL,
        params=RelayParams(audio_in_enabled=True, audio_out_enabled=True),
    )
    llm = GrokRealtimeLLMService(
        api_key=os.environ["XAI_API_KEY"],
        settings=GrokRealtimeLLMService.Settings(
            system_instruction=PERSONA,
            session_properties=events.SessionProperties(voice=os.environ.get("XAI_VOICE", "eve")),
        ),
    )

    context = LLMContext()
    aggregators = LLMContextAggregatorPair(context)
    worker = PipelineWorker(
        Pipeline([transport.input(), aggregators.user(), llm, transport.output(), aggregators.assistant()]),
        params=PipelineParams(audio_in_sample_rate=24_000, audio_out_sample_rate=24_000),
        cancel_on_idle_timeout=False,
    )

    @transport.event_handler("on_first_participant_joined")
    async def on_first_participant_joined(transport: RelayTransport, participant_id: str) -> None:
        # Grok greets the caller in its own words.
        context.add_message({"role": "system", "content": "The caller just picked up. Greet them."})
        await worker.queue_frame(LLMRunFrame())

    @transport.event_handler("on_participant_left")
    async def on_participant_left(transport: RelayTransport, participant_id: str, reason: str) -> None:
        logger.info(f"Call ended: {reason}")
        await worker.cancel()

    runner = WorkerRunner()
    await runner.add_workers(worker)
    await runner.run()


if __name__ == "__main__":
    logger.remove()
    logger.add(sys.stderr, level=os.environ.get("LOG_LEVEL", "INFO"))
    asyncio.run(main())
