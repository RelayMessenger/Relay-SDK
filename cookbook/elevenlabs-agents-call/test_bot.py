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


async def test_calls_run_side_by_side_once_each_and_a_failed_call_is_logged(monkeypatch) -> None:
    import asyncio

    from loguru import logger

    import bot

    answered: list[str] = []
    second_started = asyncio.Event()
    logged: list[str] = []
    overlapped: list[bool] = []
    sink = logger.add(lambda message: logged.append(str(message)), level="ERROR")

    async def answer(call_id: str) -> None:
        answered.append(call_id)
        if call_id == "c1":
            # The first call is still running when the second one rings.
            await asyncio.wait_for(second_started.wait(), 1)
            overlapped.append(True)
            raise RuntimeError("the call failed")
        second_started.set()

    async def fake_run_websocket(base_url, token, *, on_event, on_full_sync, on_error):  # type: ignore[no-untyped-def]
        created = {"event_id": "e1", "event_type": "call.created", "data": {"call": {"id": "c1"}}}
        await on_event(created, {"sequence": "1"})
        await on_event(created, {"sequence": "1"})  # redelivered
        await on_event({"event_id": "e2", "event_type": "message.received", "data": {}}, {"sequence": "2"})
        await on_event({"event_id": "e3", "event_type": "call.created", "data": {"call": {"id": "c2"}}}, {"sequence": "3"})
        await on_full_sync({"through_sequence": "3", "reason": "checkpoint_outside_retention"})
        await asyncio.sleep(0.2)

    monkeypatch.setattr(bot, "run_websocket", fake_run_websocket)
    try:
        await bot.serve("token", answer)
    finally:
        logger.remove(sink)
    assert answered == ["c1", "c2"]
    assert overlapped == [True]
    assert any("Call c1 failed" in line for line in logged)


def test_tests_never_reach_the_network() -> None:
    import socket

    import pytest

    # 192.0.2.1 is TEST-NET-1 (RFC 5737): reserved, never a real service.
    with pytest.raises(RuntimeError, match="never reach the network"):
        socket.create_connection(("192.0.2.1", 443), timeout=1)
