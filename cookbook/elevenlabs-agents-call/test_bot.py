"""The bridge's ElevenLabs protocol handling, offline, against a fake socket."""

import asyncio
import base64
import json
import time
from typing import Any
from unittest.mock import AsyncMock

import pytest
import websockets
from pipecat.frames.frames import OutputAudioRawFrame

from bot import ElevenLabsAgentBridge


class FakeSocket:
    def __init__(self, messages: list[dict[str, Any]] | None = None, close_after: bool = True) -> None:
        self.sent: list[dict[str, Any]] = []
        self._messages = list(messages or [])

    async def send(self, raw: str) -> None:
        self.sent.append(json.loads(raw))

    def __aiter__(self) -> "FakeSocket":
        return self

    async def __anext__(self) -> str:
        if self._messages:
            return json.dumps(self._messages.pop(0))
        raise websockets.ConnectionClosedOK(None, None)

    async def close(self) -> None:
        pass


def audio(event_id: int, payload: bytes) -> dict[str, Any]:
    return {"type": "audio", "audio_event": {"event_id": event_id, "audio_base_64": base64.b64encode(payload).decode()}}


def bridge(socket: FakeSocket, on_closed: AsyncMock | None = None) -> ElevenLabsAgentBridge:
    b = ElevenLabsAgentBridge("key", "agent", on_closed=on_closed or AsyncMock())
    b._ws = socket
    b.push_frame = AsyncMock()  # type: ignore[method-assign]
    b.broadcast_interruption = AsyncMock()  # type: ignore[method-assign]
    return b


async def test_audio_at_or_below_the_last_interruption_is_dropped() -> None:
    b = bridge(FakeSocket())
    await b.handle_message(audio(3, b"old"))
    await b.handle_message({"type": "interruption", "interruption_event": {"event_id": 5}})
    await b.handle_message(audio(4, b"stale"))
    await b.handle_message(audio(5, b"stale"))
    await b.handle_message(audio(6, b"new"))

    played = [call.args[0].audio for call in b.push_frame.await_args_list if isinstance(call.args[0], OutputAudioRawFrame)]
    assert played == [b"old", b"new"]
    b.broadcast_interruption.assert_awaited_once()


async def test_a_ping_is_answered_at_once() -> None:
    socket = FakeSocket()
    b = bridge(socket)
    started = time.monotonic()
    await b.handle_message({"type": "ping", "ping_event": {"event_id": 9, "ping_ms": 3000}})
    assert time.monotonic() - started < 0.5
    assert socket.sent == [{"type": "pong", "event_id": 9}]


async def test_when_elevenlabs_closes_the_call_ends_and_audio_stops() -> None:
    socket = FakeSocket([audio(1, b"bye")])
    on_closed = AsyncMock()
    b = bridge(socket, on_closed)
    await b._read()
    on_closed.assert_awaited_once()
    await b.send_audio(b"caller")
    assert socket.sent == []


def test_the_pipeline_builds_offline() -> None:
    from bot import build

    transport, worker = build("test-token", "00000000-0000-0000-0000-000000000000", "test-key", "agent")
    assert worker is not None and transport is not None
