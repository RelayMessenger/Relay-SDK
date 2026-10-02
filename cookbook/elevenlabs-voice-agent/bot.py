"""Answer a Relay Call with Grok as the brain and an ElevenLabs voice.

    RELAY_AGENT_TOKEN=... XAI_API_KEY=... ELEVENLABS_API_KEY=... uv run bot.py

The bot listens on the Agent WebSocket for ``call.created``, joins each Call with
`RelayTransport` (joining answers it) and runs one Pipecat pipeline:

    caller's voice -> ElevenLabs Scribe (speech to text) -> Grok (xAI Responses API) -> ElevenLabs (text to speech) -> caller

It greets the caller once their audio arrives and leaves when the Call ends. It keeps running and answers every Call.
RELAY_BASE_URL selects another Relay API origin.
"""

import asyncio
import os
import sys
from collections.abc import Awaitable, Callable
from typing import Any

from loguru import logger
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.frames.frames import LLMRunFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
from pipecat.services.elevenlabs.stt import ElevenLabsRealtimeSTTService
from pipecat.services.elevenlabs.tts import ElevenLabsTTSService
from pipecat.services.openai.responses.llm import OpenAIResponsesHttpLLMService
from pipecat.workers.runner import WorkerRunner

from relaymessenger import WebSocketEventContext, WebSocketFullSyncContext
from relaymessenger.websocket import run_websocket
from relaymessenger_pipecat import RelayParams, RelayTransport

BASE_URL = os.environ.get("RELAY_BASE_URL", "https://api.relayapp.im")
# Diego's voice: "Harry", the highest-pitched male premade voice, which every ElevenLabs
# plan can use through the API.
# Set ELEVENLABS_VOICE_ID to use another voice.
VOICE_ID = os.environ.get("ELEVENLABS_VOICE_ID", "SOYHLrjzK2X1ezoPC6cr")
# A call needs a reply in under a second: the non-reasoning model answered in
# 0.4-0.6 s, grok-4.7 in 1.7-3.3 s even at its lowest reasoning effort.
GROK_MODEL = os.environ.get("XAI_MODEL", "grok-4.20-0309-non-reasoning")
# xAI serves the Responses API at this origin; Pipecat's Responses service speaks it.
XAI_BASE_URL = "https://api.x.ai/v1"
PERSONA = os.environ.get(
    "AGENT_PERSONA",
    "You are Diego, a chubby, fast-talking squirrel who lives on the University of Michigan Diag. "
    "You are on a voice call: answer in one or two short spoken sentences, with no lists, "
    "emoji or markdown. You love acorns, campus gossip and helping students find their way.",
)



# The greeting cue joins the context as a developer message, so the persona
# stays the one system instruction and Grok greets in its own words.
GREETING_CUE = {"role": "developer", "content": "The caller just picked up. Greet them."}


def build(token: str, call_id: str, xai_key: str, elevenlabs_key: str) -> tuple[RelayTransport, PipelineWorker, LLMContext]:
    """The transport, pipeline and context for one Call. Nothing connects until the worker runs."""
    transport = RelayTransport(
        api_key=token,
        call_id=call_id,
        base_url=BASE_URL,
        params=RelayParams(audio_in_enabled=True, audio_out_enabled=True),
    )
    stt = ElevenLabsRealtimeSTTService(api_key=elevenlabs_key)
    llm = OpenAIResponsesHttpLLMService(
        api_key=xai_key,
        base_url=XAI_BASE_URL,
        settings=OpenAIResponsesHttpLLMService.Settings(
            model=GROK_MODEL,
            system_instruction=PERSONA,
        ),
    )
    tts = ElevenLabsTTSService(
        api_key=elevenlabs_key,
        settings=ElevenLabsTTSService.Settings(
            voice=VOICE_ID,
            model="eleven_flash_v2_5",
            stability=0.3,
            similarity_boost=0.75,
            style=0.0,
            use_speaker_boost=True,
            speed=1.2,
        ),
    )

    context = LLMContext()
    aggregators = LLMContextAggregatorPair(
        context, user_params=LLMUserAggregatorParams(vad_analyzer=SileroVADAnalyzer())
    )
    worker = PipelineWorker(
        Pipeline([transport.input(), stt, aggregators.user(), llm, tts, transport.output(), aggregators.assistant()]),
        params=PipelineParams(audio_in_sample_rate=16_000, audio_out_sample_rate=24_000),
        cancel_on_idle_timeout=False,
    )

    @transport.event_handler("on_first_participant_joined")
    async def on_first_participant_joined(transport: RelayTransport, participant_id: str) -> None:
        context.add_message(GREETING_CUE)  # type: ignore[arg-type]
        await worker.queue_frame(LLMRunFrame())

    @transport.event_handler("on_participant_left")
    async def on_participant_left(transport: RelayTransport, participant_id: str, reason: str) -> None:
        logger.info(f"Call ended: {reason}")
        await worker.cancel()

    return transport, worker, context


def call_id_of(event: dict[str, Any]) -> str | None:
    """The Call to answer, for a ``call.created`` event; otherwise None."""
    if event.get("event_type") != "call.created":
        return None
    return str(event["data"]["call"]["id"])


async def serve(token: str, answer: Callable[[str], Awaitable[None]]) -> None:
    """Answers every Call, one task each, until the process is stopped.

    The Agent WebSocket client is the Relay SDK's own (``run_websocket``): it
    sends Relay's JSON heartbeat, reconnects with backoff when the socket
    drops, and acknowledges an event only after ``on_event`` returns. A Call
    that rang while the bot was offline has already ended (the ring lasts
    32 seconds), so a FULL sync has nothing to recover.
    """
    calls: set[asyncio.Task[None]] = set()
    seen: set[str] = set()

    async def answer_safely(call_id: str) -> None:
        try:
            await answer(call_id)
        except Exception:
            logger.exception(f"Call {call_id} failed")

    async def on_event(event: dict[str, Any], context: WebSocketEventContext) -> None:
        call_id = call_id_of(event)
        if call_id is None or event["event_id"] in seen:
            return
        seen.add(event["event_id"])
        logger.info(f"Answering call {call_id}")
        task = asyncio.create_task(answer_safely(call_id))
        calls.add(task)
        task.add_done_callback(calls.discard)

    async def on_full_sync(context: WebSocketFullSyncContext) -> None:
        logger.info(f"FULL sync through {context['through_sequence']}: no Call to recover")

    def on_error(error: Exception) -> None:
        logger.warning(f"Agent WebSocket: {error}")

    await run_websocket(BASE_URL, token, on_event=on_event, on_full_sync=on_full_sync, on_error=on_error)


async def run_call(worker: PipelineWorker) -> None:
    runner = WorkerRunner(handle_sigint=False)
    await runner.add_workers(worker)
    await runner.run()


async def main() -> None:
    token = os.environ["RELAY_AGENT_TOKEN"]

    async def answer(call_id: str) -> None:
        _, worker, _ = build(token, call_id, os.environ["XAI_API_KEY"], os.environ["ELEVENLABS_API_KEY"])
        await run_call(worker)

    logger.info("Waiting for calls")
    await serve(token, answer)


if __name__ == "__main__":
    logger.remove()
    logger.add(sys.stderr, level=os.environ.get("LOG_LEVEL", "INFO"))
    asyncio.run(main())
