"""Call room: frame validation, PartySocket reconnect timings, heartbeat, frames sent on every open."""

from __future__ import annotations

import asyncio
import json
from typing import Any, Callable, Optional, Union

import pytest

from relaymessenger_livekit import room as room_module
from relaymessenger_livekit.room import (
    CallRoom,
    CallRoomError,
    CallRoomReconnectingEvent,
    call_room_url,
    parse_call_room_server_frame,
)

PARTICIPANT = {"contact_id": "c1", "kind": "user", "attached": True, "track": "audio", "muted": False, "connected": True}
AGENT = {**PARTICIPANT, "contact_id": "c2", "kind": "agent"}
CALL = {"id": "call_1", "chat_id": "chat_1", "status": "in-progress"}


def room_state(**overrides: Any) -> dict[str, Any]:
    return {"type": "roomState", "call": {**CALL, **overrides}, "participants": [PARTICIPANT, AGENT]}


# ---- frames --------------------------------------------------------------------------------------------------------


def test_room_state_accepts_the_three_track_shapes() -> None:
    for tracks in ([], ["audio"], ["audio", "video"]):
        person = {**PARTICIPANT, "video": False, "tracks": tracks}
        frame = {"type": "roomState", "call": CALL, "participants": [person, AGENT]}
        assert parse_call_room_server_frame(frame) == frame


@pytest.mark.parametrize(
    "frame",
    [
        {"type": "roomState", "call": CALL, "participants": [PARTICIPANT]},
        {"type": "roomState", "call": CALL, "participants": [{**PARTICIPANT, "tracks": ["video", "video"]}, AGENT]},
        {"type": "roomState", "call": CALL, "participants": [{**PARTICIPANT, "extra": 1}, AGENT]},
        {"type": "answer", "session_description": {"type": "offer", "sdp": "v=0"}},
        {"type": "offer", "session_description": {"type": "offer", "sdp": "v=0"}, "track": "screen"},
        {"type": "ended", "reason": "disconnected"},
        {"type": "error", "code": "boom", "message": "x"},
        {"type": "heartbeat", "extra": True},
        {"type": "unknown"},
        [],
    ],
)
def test_invalid_frames_raise(frame: Any) -> None:
    with pytest.raises(CallRoomError):
        parse_call_room_server_frame(frame)


def test_heartbeat_echo_is_not_a_frame() -> None:
    assert parse_call_room_server_frame({"type": "heartbeat"}) is None


def test_room_url_is_the_public_call_room() -> None:
    assert call_room_url("https://api.staging.relayapp.im/", "call 1") == "wss://api.staging.relayapp.im/v1/calls/call%201/room"
    assert call_room_url("http://localhost:8787", "c") == "ws://localhost:8787/v1/calls/c/room"


# ---- socket lifecycle ------------------------------------------------------------------------------------------------


class FakeSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []
        self._inbox: asyncio.Queue[Optional[Union[str, bytes]]] = asyncio.Queue()
        self.close_code: Optional[int] = None
        self.close_reason: Optional[str] = None
        self.closed_with: Optional[tuple[int, str]] = None

    async def send(self, message: str) -> None:
        self.sent.append(json.loads(message))

    async def recv(self) -> Union[str, bytes]:
        item = await self._inbox.get()
        if item is None:
            raise ConnectionError("closed")
        return item

    async def close(self, code: int = 1000, reason: str = "") -> None:
        self.closed_with = (code, reason)
        self.drop(code, reason)

    def push(self, frame: dict[str, Any]) -> None:
        self._inbox.put_nowait(json.dumps(frame))

    def drop(self, code: Optional[int] = None, reason: str = "") -> None:
        self.close_code, self.close_reason = code, reason
        self._inbox.put_nowait(None)


class Harness:
    """A room whose timers are recorded and fired by hand, and whose connector hands out fake sockets."""

    def __init__(self, fail: int = 0) -> None:
        self.sockets: list[FakeSocket] = []
        self.fail = fail
        self.timers: list[tuple[float, Callable[[], None], "FakeHandle"]] = []
        self.reconnecting: list[CallRoomReconnectingEvent] = []
        self.room = CallRoom("call_1", api_key="k", connector=self.connect, _call_later=self.call_later)
        self.room.on("reconnecting", self.reconnecting.append)

    async def connect(self, url: str, headers: dict[str, str]) -> FakeSocket:
        assert headers == {"Authorization": "Bearer k"}
        if self.fail > 0:
            self.fail -= 1
            raise OSError("refused")
        socket = FakeSocket()
        self.sockets.append(socket)
        return socket

    def call_later(self, delay: float, callback: Callable[[], None]) -> "FakeHandle":
        handle = FakeHandle()
        self.timers.append((delay, callback, handle))
        return handle

    def pending(self, delay: float) -> list[tuple[float, Callable[[], None], "FakeHandle"]]:
        return [t for t in self.timers if abs(t[0] - delay) < 1e-9 and not t[2].cancelled]

    async def fire(self, delay: float) -> None:
        timers = self.pending(delay)
        assert timers, f"no timer of {delay}s pending: {[t[0] for t in self.timers if not t[2].cancelled]}"
        _, callback, handle = timers[0]
        handle.cancelled = True
        callback()
        await settle()


class FakeHandle:
    def __init__(self) -> None:
        self.cancelled = False

    def cancel(self) -> None:
        self.cancelled = True


async def settle() -> None:
    for _ in range(10):
        await asyncio.sleep(0)


async def test_join_then_user_update_then_queued_frames_on_every_open() -> None:
    h = Harness()
    await h.room.connect()
    await settle()
    assert h.sockets[0].sent == [{"type": "join"}]
    h.room.user_update(muted=True, video=True)
    await settle()
    h.sockets[0].drop(1006)
    await settle()
    # While closed: offers queue, heartbeats and userUpdate do not.
    h.room.send({"type": "answer", "session_description": {"type": "answer", "sdp": "x"}})
    h.room.send({"type": "heartbeat"})
    h.room.user_update(muted=False)
    await h.fire(3.0)
    assert h.sockets[1].sent == [
        {"type": "join"},
        {"type": "userUpdate", "muted": False, "video": True},
        {"type": "answer", "session_description": {"type": "answer", "sdp": "x"}},
    ]


async def test_reconnect_delays_are_partysocket_3000_x1_3_cap_10000() -> None:
    assert (room_module.MIN_RECONNECTION_DELAY_MS, room_module.RECONNECTION_DELAY_GROW_FACTOR) == (3_000, 1.3)
    assert (room_module.MAX_RECONNECTION_DELAY_MS, room_module.CONNECTION_TIMEOUT_MS) == (10_000, 4_000)
    h = Harness()
    await h.room.connect()
    await settle()
    h.fail = 10
    h.sockets[0].drop(1006)
    await settle()
    expected = [3000, 3900, 5070, 6591, 8568.3, 10000, 10000]
    for delay in expected[:-1]:
        await h.fire(delay / 1000)
    delays = [round(e.delay_ms, 1) for e in h.reconnecting]
    assert delays == expected
    assert h.reconnecting[0].close is not None and h.reconnecting[0].close.code == 1006
    assert all(e.error is not None for e in h.reconnecting[1:])
    assert h.room.connection_state == "reconnecting"


async def test_retry_count_resets_after_five_seconds_open() -> None:
    h = Harness()
    await h.room.connect()
    await settle()
    h.sockets[0].drop(1006)
    await settle()
    await h.fire(3.0)
    h.sockets[1].drop(1006)
    await settle()
    assert [e.delay_ms for e in h.reconnecting] == [3000, 3900]
    await h.fire(3.9)
    await h.fire(5.0)  # uptime timer: the socket stayed open 5 s
    h.sockets[2].drop(1006)
    await settle()
    assert h.reconnecting[-1].delay_ms == 3000


@pytest.mark.parametrize("code,reason", [(1000, "Replaced"), (1000, "Call ended"), (4400, "invalid frame")])
async def test_closes_that_were_asked_for_are_final(code: int, reason: str) -> None:
    h = Harness()
    closes = []
    h.room.on("close", closes.append)
    await h.room.connect()
    await settle()
    h.sockets[0].drop(code, reason)
    await settle()
    assert h.reconnecting == []
    assert [c.code for c in closes] == [code]


async def test_a_terminal_call_status_is_final() -> None:
    h = Harness()
    await h.room.connect()
    await settle()
    h.sockets[0].push(room_state(status="completed"))
    await settle()
    h.sockets[0].drop(1006)
    await settle()
    assert h.reconnecting == []


async def test_heartbeat_every_five_seconds() -> None:
    assert room_module.DEFAULT_HEARTBEAT_INTERVAL_MS == 5_000
    h = Harness()
    await h.room.connect()
    await settle()
    # Three 5 s timers fire: the 5 s uptime timer (armed first on open) and two heartbeats.
    for _ in range(3):
        await h.fire(5.0)
    assert h.sockets[0].sent[1:] == [{"type": "heartbeat"}, {"type": "heartbeat"}]


async def test_invalid_frame_closes_4400_and_emits_error() -> None:
    h = Harness()
    errors = []
    h.room.on("error", errors.append)
    await h.room.connect()
    await settle()
    h.sockets[0].push({"type": "roomState"})
    await settle()
    assert isinstance(errors[0], CallRoomError)
    assert h.sockets[0].closed_with == (4400, "invalid frame")


async def test_frames_reach_listeners() -> None:
    h = Harness()
    seen: list[tuple[str, Any]] = []
    for name in ("room_state", "offer", "answer", "ended", "error"):
        h.room.on(name, lambda frame, name=name: seen.append((name, frame["type"])))
    await h.room.connect()
    await settle()
    socket = h.sockets[0]
    socket.push(room_state())
    socket.push({"type": "offer", "session_description": {"type": "offer", "sdp": "v=0"}, "track": "video"})
    socket.push({"type": "answer", "session_description": {"type": "answer", "sdp": "v=0"}})
    socket.push({"type": "heartbeat"})
    socket.push({"type": "error", "code": "not_allowed", "message": "no"})
    socket.push({"type": "ended", "reason": "completed"})
    await settle()
    assert seen == [("room_state", "roomState"), ("offer", "offer"), ("answer", "answer"), ("error", "error"), ("ended", "ended")]
    assert h.room.state is not None


async def test_manual_reconnect_opens_a_new_socket_and_replaces_the_old() -> None:
    h = Harness()
    await h.room.connect()
    await settle()
    await h.room.reconnect()
    await settle()
    assert len(h.sockets) == 2
    assert h.sockets[0].closed_with == (1000, "Replaced")
    assert h.room.connection_state == "open"
