"""Answer the next Relay Call with a LiveKit AgentSession on Gemini Live that
sees the caller's camera and sends a camera feed back.

    uv run --with 'livekit-agents[google]' examples/gemini_live_video_agent.py

Needs RELAY_AGENT_TOKEN and GOOGLE_API_KEY. The agent waits on the Agent
WebSocket for ``call.created``, joins that Call (joining answers it), and
closes when the Call ends. Video in: ``call.attach(session)`` makes the
caller's camera the session's video input, which the AgentSession samples
into Gemini Live. Video out: a ``VideoSource`` published as the agent's camera
with LiveKit's names (``LocalVideoTrack.create_video_track``), here colour
bars with a sweeping white bar at 30 frames a second. RELAY_BASE_URL selects
another Relay API origin.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from typing import Any

import numpy as np
import websockets
from livekit import rtc
from livekit.agents import Agent, AgentSession
from livekit.plugins import google

from relaymessenger_livekit import LocalVideoTrack, RelayLiveKitCall, VideoSource

BASE_URL = os.environ.get("RELAY_BASE_URL", "https://api.relayapp.im")
WIDTH, HEIGHT, FPS = 640, 360, 30
logger = logging.getLogger("gemini_live_video_agent")


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


def colour_bars(index: int) -> rtc.VideoFrame:
    """Colour bars with a white bar sweeping across them, as RGBA."""
    image = np.zeros((HEIGHT, WIDTH, 4), dtype=np.uint8)
    image[..., 3] = 255
    colours = [(235, 235, 235), (235, 235, 16), (16, 235, 235), (16, 235, 16), (235, 16, 235), (235, 16, 16), (16, 16, 235)]
    for i, colour in enumerate(colours):
        image[:, i * WIDTH // 7 : (i + 1) * WIDTH // 7, :3] = colour
    x = (index * 8) % WIDTH
    image[:, x : x + 24, :3] = 255
    return rtc.VideoFrame(WIDTH, HEIGHT, rtc.VideoBufferType.RGBA, image.tobytes())


async def send_camera(source: VideoSource) -> None:
    index = 0
    while True:
        source.capture_frame(colour_bars(index))
        index += 1
        await asyncio.sleep(1 / FPS)


async def main() -> None:
    token = os.environ["RELAY_AGENT_TOKEN"]
    logger.info("Waiting for a call")
    call_id = await next_call(token)
    logger.info("Answering call %s", call_id)

    call = await RelayLiveKitCall.connect(api_key=token, call_id=call_id, base_url=BASE_URL)
    ended = asyncio.Event()

    @call.transport.on("ended")
    def _ended(_frame: dict[str, Any]) -> None:
        ended.set()

    source = VideoSource(WIDTH, HEIGHT)
    await call.transport.publish_track(LocalVideoTrack.create_video_track("camera", source))
    camera = asyncio.create_task(send_camera(source))

    session: AgentSession[None] = AgentSession(llm=google.realtime.RealtimeModel())
    call.attach(session)  # audio in, audio out, and the caller's camera
    try:
        await call.wait_for_peer_audio(15_000)
        await session.start(
            Agent(instructions="You are on a video call. Describe what the caller shows you when they ask, briefly.")
        )
        await ended.wait()
        logger.info("Call ended: %s", call.diagnostics().summary)
    finally:
        camera.cancel()
        await session.aclose()
        await call.aclose()


if __name__ == "__main__":
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
    asyncio.run(main())
