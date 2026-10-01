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
from typing import Any

import aiohttp
import websockets
from loguru import logger
from pipecat.frames.frames import (
    CancelFrame,
    EndFrame,
    Frame,
    InputAudioRawFrame,
    InterruptionFrame,
    OutputAudioRawFrame,
    StartFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.workers.runner import WorkerRunner

from relaymessenger_pipecat import RelayParams, RelayTransport

BASE_URL = os.environ.get("RELAY_BASE_URL", "https://api.relayapp.im")
ELEVENLABS = "https://api.elevenlabs.io"
SAMPLE_RATE = 16_000  # pcm_16000 on both sides of the ElevenLabs Agent


class ElevenLabsAgentBridge(FrameProcessor):
    """Sends the caller's audio to an ElevenLabs Agent and plays the agent's audio back into the Call."""

    def __init__(self, api_key: str, agent_id: str) -> None:
        super().__init__()
        self._api_key = api_key
        self._agent_id = agent_id
        self._ws: Any = None
        self._reader: asyncio.Task[None] | None = None

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
        async for raw in self._ws:
            message = json.loads(raw)
            kind = message.get("type")
            if kind == "conversation_initiation_metadata":
                event = message["conversation_initiation_metadata_event"]
                logger.info(
                    f"ElevenLabs conversation {event['conversation_id']}: in {event['user_input_audio_format']}, "
                    f"out {event['agent_output_audio_format']}"
                )
            elif kind == "audio":
                audio = base64.b64decode(message["audio_event"]["audio_base_64"])
                await self.push_frame(OutputAudioRawFrame(audio=audio, sample_rate=SAMPLE_RATE, num_channels=1))
            elif kind == "interruption":
                # The caller talked over the agent: drop the agent's queued audio.
                await self.push_frame(InterruptionFrame())
            elif kind == "ping":
                event = message["ping_event"]
                await asyncio.sleep((event.get("ping_ms") or 0) / 1000)
                await self._ws.send(json.dumps({"type": "pong", "event_id": event["event_id"]}))
            elif kind == "user_transcript":
                logger.info(f"Caller: {message['user_transcription_event']['user_transcript']}")
            elif kind == "agent_response":
                logger.info(f"Agent: {message['agent_response_event']['agent_response']}")

    async def _close(self) -> None:
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
            if self._ws is not None:
                await self._ws.send(json.dumps({"user_audio_chunk": base64.b64encode(frame.audio).decode()}))
        elif isinstance(frame, (EndFrame, CancelFrame)):
            await self._close()
            await self.push_frame(frame, direction)
        else:
            await self.push_frame(frame, direction)


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
    bridge = ElevenLabsAgentBridge(os.environ["ELEVENLABS_API_KEY"], os.environ["ELEVENLABS_AGENT_ID"])
    worker = PipelineWorker(
        Pipeline([transport.input(), bridge, transport.output()]),
        params=PipelineParams(audio_in_sample_rate=SAMPLE_RATE, audio_out_sample_rate=SAMPLE_RATE),
        cancel_on_idle_timeout=False,
    )

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
