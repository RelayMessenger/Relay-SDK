"""Put an ElevenLabs Agent on a Relay Call through the ElevenLabs Agents WebSocket API.

    RELAY_AGENT_TOKEN=... ELEVENLABS_API_KEY=... ELEVENLABS_AGENT_ID=... uv run bot.py

ElevenLabs runs the whole conversation (speech recognition, the LLM, the voice,
turn-taking); this bot only carries audio. It waits on the Agent WebSocket for
``call.created``, joins that Call with `RelayTransport` (joining answers it), and
bridges the caller's audio to wss://api.elevenlabs.io/v1/convai/conversation,
the documented path for custom integrations
(https://elevenlabs.io/docs/eleven-agents/libraries/web-sockets). Both sides use
16 kHz PCM, the agent's default `user_input_audio_format` and
`agent_output_audio_format` (`pcm_16000`). create_agent.py makes such an agent.
"""

import asyncio
import base64
import json
import os
import sys
from collections.abc import Awaitable, Callable
from typing import Any

import aiohttp
import websockets
from loguru import logger
from pipecat.frames.frames import (
    CancelFrame,
    EndFrame,
    Frame,
    InputAudioRawFrame,
    OutputAudioRawFrame,
    StartFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.workers.runner import WorkerRunner

from relaymessenger import WebSocketEventContext, WebSocketFullSyncContext
from relaymessenger.websocket import run_websocket
from relaymessenger_pipecat import RelayParams, RelayTransport

BASE_URL = os.environ.get("RELAY_BASE_URL", "https://api.relayapp.im")
ELEVENLABS = "https://api.elevenlabs.io"
SAMPLE_RATE = 16_000  # pcm_16000 on both sides of the ElevenLabs Agent


class ElevenLabsAgentBridge(FrameProcessor):
    """Sends the caller's audio to an ElevenLabs Agent and plays the agent's audio back into the Call.

    It follows ElevenLabs' own Python SDK (elevenlabs.conversational_ai.conversation):
    audio whose event_id is at or below the last interruption is dropped, every ping
    is answered with a pong at once, and the session ends when ElevenLabs closes it.
    """

    def __init__(self, api_key: str, agent_id: str, on_closed: Callable[[], Awaitable[None]]) -> None:
        super().__init__()
        self._api_key = api_key
        self._agent_id = agent_id
        self._on_closed = on_closed
        self._ws: Any = None
        self._reader: asyncio.Task[None] | None = None
        self._last_interrupt_id = 0
        self._closed = False

    async def _signed_url(self) -> str:
        async with aiohttp.ClientSession(headers={"xi-api-key": self._api_key}) as http:
            async with http.get(
                f"{ELEVENLABS}/v1/convai/conversation/get-signed-url", params={"agent_id": self._agent_id}
            ) as response:
                response.raise_for_status()
                return str((await response.json())["signed_url"])

    async def _connect(self) -> None:
        self._ws = await websockets.connect(await self._signed_url())
        await self._ws.send(json.dumps({"type": "conversation_initiation_client_data"}))
        self._reader = asyncio.create_task(self._read())

    async def _read(self) -> None:
        try:
            async for raw in self._ws:
                await self.handle_message(json.loads(raw))
        except websockets.ConnectionClosed:
            pass
        await self._session_ended()

    async def _session_ended(self) -> None:
        """ElevenLabs closed the conversation: stop sending audio and end the Relay Call."""
        if self._closed:
            return
        self._closed = True
        logger.info("ElevenLabs ended the conversation")
        await self._on_closed()

    async def handle_message(self, message: dict[str, Any]) -> None:
        kind = message.get("type")
        if kind == "conversation_initiation_metadata":
            event = message["conversation_initiation_metadata_event"]
            logger.info(
                f"ElevenLabs conversation {event['conversation_id']}: in {event['user_input_audio_format']}, "
                f"out {event['agent_output_audio_format']}"
            )
        elif kind == "audio":
            event = message["audio_event"]
            # Audio from a response the caller already interrupted is stale.
            if int(event["event_id"]) <= self._last_interrupt_id:
                return
            audio = base64.b64decode(event["audio_base_64"])
            await self.push_frame(OutputAudioRawFrame(audio=audio, sample_rate=SAMPLE_RATE, num_channels=1))
        elif kind == "interruption":
            # The caller talked over the agent: drop the agent's queued audio.
            self._last_interrupt_id = int(message["interruption_event"]["event_id"])
            await self.broadcast_interruption()
        elif kind == "ping":
            await self._ws.send(json.dumps({"type": "pong", "event_id": message["ping_event"]["event_id"]}))
        elif kind == "user_transcript":
            logger.info(f"Caller: {message['user_transcription_event']['user_transcript']}")
        elif kind == "agent_response":
            logger.info(f"Agent: {message['agent_response_event']['agent_response']}")

    async def send_audio(self, audio: bytes) -> None:
        """One chunk of the caller's audio, unless ElevenLabs has ended the conversation."""
        if self._ws is None or self._closed:
            return
        try:
            await self._ws.send(json.dumps({"user_audio_chunk": base64.b64encode(audio).decode()}))
        except websockets.ConnectionClosed:
            await self._session_ended()

    async def _close(self) -> None:
        self._closed = True
        if self._reader is not None:
            self._reader.cancel()
        if self._ws is not None:
            await self._ws.close()

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if isinstance(frame, StartFrame):
            await self.push_frame(frame, direction)
            await self._connect()
        elif isinstance(frame, InputAudioRawFrame):
            await self.send_audio(frame.audio)
        elif isinstance(frame, (EndFrame, CancelFrame)):
            await self._close()
            await self.push_frame(frame, direction)
        else:
            await self.push_frame(frame, direction)


def build(token: str, call_id: str, api_key: str, agent_id: str) -> tuple[RelayTransport, PipelineWorker]:
    """The transport and pipeline for one Call. Nothing connects until the worker runs."""
    transport = RelayTransport(
        api_key=token,
        call_id=call_id,
        base_url=BASE_URL,
        params=RelayParams(audio_in_enabled=True, audio_out_enabled=True),
    )

    async def end_call() -> None:
        transport.end()

    bridge = ElevenLabsAgentBridge(api_key, agent_id, on_closed=end_call)
    worker = PipelineWorker(
        Pipeline([transport.input(), bridge, transport.output()]),
        params=PipelineParams(audio_in_sample_rate=SAMPLE_RATE, audio_out_sample_rate=SAMPLE_RATE),
        cancel_on_idle_timeout=False,
    )

    @transport.event_handler("on_participant_left")
    async def on_participant_left(transport: RelayTransport, participant_id: str, reason: str) -> None:
        logger.info(f"Call ended: {reason}")
        await worker.cancel()

    return transport, worker



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
        _, worker = build(token, call_id, os.environ["ELEVENLABS_API_KEY"], os.environ["ELEVENLABS_AGENT_ID"])
        await run_call(worker)

    logger.info("Waiting for calls")
    await serve(token, answer)


if __name__ == "__main__":
    logger.remove()
    logger.add(sys.stderr, level=os.environ.get("LOG_LEVEL", "INFO"))
    asyncio.run(main())
