"""Answer the next Relay Call as a talking Simli avatar.

    uv run --with 'pipecat-ai[simli,deepgram,cartesia,openai,silero]' examples/simli_avatar_bot.py

Pipecat's own example, examples/video-avatar/video-avatar-simli-video-service.py
(pipecat-ai/pipecat v1.11.0), with `RelayTransport` where that example uses
Daily: Deepgram hears the caller, OpenAI answers, Cartesia speaks, and
`SimliVideoService` turns the speech into 512x512 frames of a talking face,
which `RelayTransport`'s video output sends into the Call as the agent's
camera. The caller's camera arrives as video input too.

Needs RELAY_AGENT_TOKEN, SIMLI_API_KEY, DEEPGRAM_API_KEY, CARTESIA_API_KEY and
OPENAI_API_KEY. SIMLI_FACE_ID picks another face. The bot waits on the Agent
WebSocket for ``call.created``, joins that Call (joining answers it), and
leaves when the Call ends. RELAY_BASE_URL selects another Relay API origin.
"""

import asyncio
import json
import os
import sys

import websockets
from loguru import logger
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.frames.frames import LLMRunFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker, ProcessorUnusablePolicy
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
from pipecat.services.cartesia.tts import CartesiaTTSService
from pipecat.services.deepgram.stt import DeepgramSTTService
from pipecat.services.openai.llm import OpenAILLMService
from pipecat.services.simli.video import SimliVideoService
from pipecat.workers.runner import WorkerRunner

from relaymessenger_pipecat import RelayParams, RelayTransport

BASE_URL = os.environ.get("RELAY_BASE_URL", "https://api.relayapp.im")
# Simli's frames are 512x512 RGB, as in Pipecat's example.
AVATAR_SIZE = 512


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


def relay_transport(token: str, call_id: str) -> RelayTransport:
    """Pipecat's ``webrtc`` transport params from the Simli example, on Relay."""
    return RelayTransport(
        api_key=token,
        call_id=call_id,
        base_url=BASE_URL,
        params=RelayParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            video_in_enabled=True,
            video_out_enabled=True,
            video_out_is_live=True,
            video_out_width=AVATAR_SIZE,
            video_out_height=AVATAR_SIZE,
        ),
    )


def avatar_pipeline(transport: RelayTransport) -> tuple[Pipeline, LLMContextAggregatorPair]:
    stt = DeepgramSTTService(api_key=os.environ["DEEPGRAM_API_KEY"])
    tts = CartesiaTTSService(
        api_key=os.environ["CARTESIA_API_KEY"],
        settings=CartesiaTTSService.Settings(voice="f6ff7c0c-e396-40a9-a70b-f7607edb6937"),
    )
    simli_ai = SimliVideoService(
        api_key=os.environ["SIMLI_API_KEY"],
        face_id=os.environ.get("SIMLI_FACE_ID", "cace3ef7-a4c4-425d-a8cf-a5358eb0c427"),
    )
    llm = OpenAILLMService(
        api_key=os.environ["OPENAI_API_KEY"],
        settings=OpenAILLMService.Settings(
            system_instruction=(
                "You are a helpful assistant in a video call. Your responses will be spoken aloud, so avoid "
                "emojis, bullet points, or other formatting that can't be spoken. Respond to what the user said "
                "in a creative, helpful, and brief way."
            ),
        ),
    )
    context = LLMContext()
    aggregators = LLMContextAggregatorPair(
        context,
        user_params=LLMUserAggregatorParams(vad_analyzer=SileroVADAnalyzer()),
    )
    user_aggregator, assistant_aggregator = aggregators
    pipeline = Pipeline(
        [
            transport.input(),
            stt,
            user_aggregator,
            llm,
            tts,
            simli_ai,
            transport.output(),
            assistant_aggregator,
        ]
    )
    return pipeline, aggregators


async def main() -> None:
    token = os.environ["RELAY_AGENT_TOKEN"]
    logger.info("Waiting for a call")
    call_id = await next_call(token)
    logger.info(f"Answering call {call_id}")

    transport = relay_transport(token, call_id)
    pipeline, _aggregators = avatar_pipeline(transport)
    worker = PipelineWorker(
        pipeline,
        params=PipelineParams(enable_metrics=True, enable_usage_metrics=True),
        processor_unusable_policy=ProcessorUnusablePolicy.END,
        cancel_on_idle_timeout=False,
    )

    @transport.event_handler("on_connected")
    async def on_connected(transport: RelayTransport) -> None:
        logger.info("Call connected")
        # Start the conversation: an empty prompt lets the LLM follow its instruction.
        await worker.queue_frames([LLMRunFrame()])

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
