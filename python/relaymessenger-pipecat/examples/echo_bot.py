"""Answer the next Relay Call: echo the caller's voice back and send a moving test pattern.

    RELAY_AGENT_TOKEN=... uv run examples/echo_bot.py

The bot waits on the Agent WebSocket for ``call.created``, joins that Call
with `RelayTransport` (joining answers it), and leaves when the Call ends.
Set CLOUDFLARE_TURN_KEY_ID and CLOUDFLARE_TURN_KEY_API_TOKEN to relay media
through Cloudflare TURN; RELAY_BASE_URL selects another Relay API origin.
"""

import asyncio
import json
import os
import sys
from typing import Any

import aiohttp
import numpy as np
import websockets
from loguru import logger
from pipecat.frames.frames import Frame, InputAudioRawFrame, OutputAudioRawFrame, OutputImageRawFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.workers.runner import WorkerRunner

from relaymessenger_pipecat import RelayParams, RelayTransport

BASE_URL = os.environ.get("RELAY_BASE_URL", "https://api.relayapp.im")
WIDTH, HEIGHT, FPS = 640, 360, 30


class Echo(FrameProcessor):
    """Plays the caller's audio straight back to them."""

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if isinstance(frame, InputAudioRawFrame):
            await self.push_frame(
                OutputAudioRawFrame(audio=frame.audio, sample_rate=frame.sample_rate, num_channels=frame.num_channels)
            )
        else:
            await self.push_frame(frame, direction)


def test_pattern(index: int) -> OutputImageRawFrame:
    """Colour bars with a white bar sweeping across them."""
    image = np.zeros((HEIGHT, WIDTH, 3), dtype=np.uint8)
    colours = [(235, 235, 235), (235, 235, 16), (16, 235, 235), (16, 235, 16), (235, 16, 235), (235, 16, 16), (16, 16, 235)]
    for i, colour in enumerate(colours):
        image[:, i * WIDTH // 7 : (i + 1) * WIDTH // 7] = colour
    x = (index * 8) % WIDTH
    image[:, x : x + 24] = 255
    return OutputImageRawFrame(image=image.tobytes(), size=(WIDTH, HEIGHT), format="RGB")


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


async def cloudflare_ice_servers(_attempt: int) -> list[Any]:
    """Short-lived Cloudflare TURN credentials, minted per media attempt."""
    key_id, api_token = os.environ["CLOUDFLARE_TURN_KEY_ID"], os.environ["CLOUDFLARE_TURN_KEY_API_TOKEN"]
    async with aiohttp.ClientSession() as http:
        async with http.post(
            f"https://rtc.live.cloudflare.com/v1/turn/keys/{key_id}/credentials/generate-ice-servers",
            headers={"Authorization": f"Bearer {api_token}"},
            json={"ttl": 3600},
        ) as response:
            response.raise_for_status()
            return list((await response.json())["iceServers"])


async def main() -> None:
    token = os.environ["RELAY_AGENT_TOKEN"]
    logger.info("Waiting for a call")
    call_id = await next_call(token)
    logger.info(f"Answering call {call_id}")

    transport = RelayTransport(
        api_key=token,
        call_id=call_id,
        base_url=BASE_URL,
        ice_servers=cloudflare_ice_servers if os.environ.get("CLOUDFLARE_TURN_KEY_ID") else None,
        params=RelayParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            video_out_enabled=True,
            video_out_is_live=True,
            video_out_width=WIDTH,
            video_out_height=HEIGHT,
            video_out_framerate=FPS,
        ),
    )
    worker = PipelineWorker(
        Pipeline([transport.input(), Echo(), transport.output()]),
        params=PipelineParams(audio_in_sample_rate=24_000, audio_out_sample_rate=24_000),
        cancel_on_idle_timeout=False,
    )

    async def send_pattern() -> None:
        index = 0
        while True:
            await worker.queue_frame(test_pattern(index))
            index += 1
            await asyncio.sleep(1 / FPS)

    pattern: asyncio.Task[None] | None = None

    @transport.event_handler("on_connected")
    async def on_connected(transport: RelayTransport) -> None:
        nonlocal pattern
        pattern = asyncio.create_task(send_pattern())

    @transport.event_handler("on_participant_left")
    async def on_participant_left(transport: RelayTransport, participant_id: str, reason: str) -> None:
        logger.info(f"Call ended: {reason}")
        call = transport.call
        if call is not None:
            logger.info(f"{call.video_stats()}; {call.diagnostics().summary}")
        await worker.cancel()

    runner = WorkerRunner()
    await runner.add_workers(worker)
    await runner.run()
    if pattern is not None:
        pattern.cancel()


if __name__ == "__main__":
    logger.remove()
    logger.add(sys.stderr, level=os.environ.get("LOG_LEVEL", "INFO"))
    asyncio.run(main())
