"""Authenticated JSON signaling socket for one Relay Call participant.

Python twin of `packages/sdk/src/call-room.ts` (`CallRoom`) over Relay's public
`GET /v1/calls/{callId}/room` WebSocket (contracts/relay-v1-openapi.yaml,
`connectCallRoom` and `x-relay-call-room-frames`).
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Literal, Optional, Protocol, Union
from urllib.parse import quote, urlsplit, urlunsplit

from livekit import rtc

logger = logging.getLogger("relaymessenger.livekit")

#: Orange Meets heartbeat cadence (`app/hooks/useRoom.ts`, 5_000 ms).
DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000
#: PartySocket reconnect defaults (`partysocket/src/ws.ts` DEFAULT), PROTOCOL.md
#: section 5. No retry limit: the room stops only on a close that was asked for.
MIN_RECONNECTION_DELAY_MS = 3_000
RECONNECTION_DELAY_GROW_FACTOR = 1.3
MAX_RECONNECTION_DELAY_MS = 10_000
CONNECTION_TIMEOUT_MS = 4_000
MIN_UPTIME_MS = 5_000
CLIENT_PROTOCOL_ERROR = 4400
DEFAULT_BASE_URL = "https://api.relayapp.im"

TERMINAL_STATUSES = frozenset({"completed", "no-answer", "canceled", "busy", "failed"})
ROOM_ERROR_CODES = frozenset({"invalid_frame", "not_allowed", "media_unavailable"})
_ICE_URL = re.compile(r"^(stun|turns?):")
PARTICIPANT_KEYS = frozenset({"contact_id", "kind", "attached", "track", "muted", "connected"})

CallRoomConnectionState = Literal["idle", "connecting", "open", "reconnecting", "closed"]
CallRoomEvent = Literal[
    "open", "reconnecting", "ice_servers", "room_state", "offer", "answer", "ended", "error", "close"
]


class CallRoomError(Exception):
    """A room failure: a frame that failed validation, or a socket that could not open."""


@dataclass(frozen=True)
class CallRoomCloseEvent:
    code: int
    reason: str
    was_clean: bool


@dataclass(frozen=True)
class CallRoomReconnectingEvent:
    """The room socket dropped, or an attempt to open one failed; the room opens a new one after ``delay_ms``.

    Media rides the SFU, not this socket, so the Call and its WebRTC session
    continue; nothing is re-offered.
    """

    #: 1 for the first retry; the count resets once a socket stays open 5 s.
    attempt: int
    delay_ms: float
    #: The close that caused the retry; ``None`` when an attempt failed before opening.
    close: Optional[CallRoomCloseEvent] = None
    #: Why the failed attempt did not open (connect timeout, handshake error).
    error: Optional[BaseException] = None


class RoomSocket(Protocol):
    """The slice of a `websockets` client connection the room uses."""

    async def send(self, message: str) -> None: ...

    async def recv(self) -> Union[str, bytes]: ...

    async def close(self, code: int = 1000, reason: str = "") -> None: ...

    @property
    def close_code(self) -> Optional[int]: ...

    @property
    def close_reason(self) -> Optional[str]: ...


#: Opens one socket: ``(url, headers) -> socket``. Raises when the upgrade fails.
RoomConnector = Callable[[str, dict[str, str]], Awaitable[RoomSocket]]


async def _websockets_connect(url: str, headers: dict[str, str]) -> RoomSocket:
    from websockets.asyncio.client import connect

    # No library pings: Relay's room keeps its own JSON heartbeat, as the
    # TypeScript client's `ws` socket does (it sends no pings by default).
    socket: Any = await connect(url, additional_headers=headers, ping_interval=None, open_timeout=None)
    return socket  # type: ignore[no-any-return]


def _has_exact_keys(value: dict[str, Any], keys: frozenset[str] | set[str]) -> bool:
    return set(value.keys()) == set(keys)


def _valid_description(value: Any, kind: str) -> bool:
    return (
        isinstance(value, dict)
        and _has_exact_keys(value, {"type", "sdp"})
        and value.get("type") == kind
        and isinstance(value.get("sdp"), str)
        and 0 < len(value["sdp"]) <= 65_536
    )


def _valid_call(value: Any) -> bool:
    if not isinstance(value, dict):
        return False
    status = value.get("status")
    return (
        isinstance(value.get("id"), str)
        and isinstance(value.get("chat_id"), str)
        and (status in ("ringing", "in-progress") or status in TERMINAL_STATUSES)
    )


def _valid_tracks(value: Any) -> bool:
    """``[]`` before the participant's first offer, then ``["audio"]`` or ``["audio", "video"]`` (PROTOCOL.md section 3)."""
    return (
        isinstance(value, list)
        and len(value) <= 2
        and all(name in ("audio", "video") for name in value)
        and len(set(value)) == len(value)
    )


def _valid_participant(value: Any) -> bool:
    if not isinstance(value, dict):
        return False
    if not (_has_exact_keys(value, PARTICIPANT_KEYS) or _has_exact_keys(value, PARTICIPANT_KEYS | {"video", "tracks"})):
        return False
    return (
        ("video" not in value or isinstance(value["video"], bool))
        and ("tracks" not in value or _valid_tracks(value["tracks"]))
        and isinstance(value.get("contact_id"), str)
        and value.get("kind") in ("user", "agent")
        and isinstance(value.get("attached"), bool)
        and value.get("track") in ("audio", None)
        and isinstance(value.get("muted"), bool)
        and isinstance(value.get("connected"), bool)
    )


def _valid_ice_server(value: Any) -> bool:
    """Contract ``CallRoomIceServersFrame`` item: 1-16 ``stun:``/``turn:``/``turns:`` URLs, optional credentials."""
    if not isinstance(value, dict) or not set(value.keys()) <= {"urls", "username", "credential"}:
        return False
    urls = value.get("urls")
    return (
        isinstance(urls, list)
        and 1 <= len(urls) <= 16
        and all(isinstance(url, str) and _ICE_URL.match(url) for url in urls)
        and ("username" not in value or isinstance(value["username"], str))
        and ("credential" not in value or isinstance(value["credential"], str))
    )


def parse_call_room_server_frame(value: Any) -> Optional[dict[str, Any]]:
    """Validate one server frame before exposing it to application code.

    Returns ``None`` for Relay's echoed heartbeat, which is not part of the
    public server-frame union; raises `CallRoomError` for anything invalid.
    """
    if not isinstance(value, dict) or not isinstance(value.get("type"), str):
        raise CallRoomError("Relay Call room received an invalid frame.")
    kind = value["type"]
    if kind == "heartbeat":
        if _has_exact_keys(value, {"type"}):
            return None
    elif kind == "iceServers":
        servers = value.get("ice_servers")
        if (
            _has_exact_keys(value, {"type", "ice_servers"})
            and isinstance(servers, list)
            and 1 <= len(servers) <= 8
            and all(_valid_ice_server(s) for s in servers)
        ):
            return value
    elif kind == "roomState":
        participants = value.get("participants")
        if (
            _has_exact_keys(value, {"type", "call", "participants"})
            and _valid_call(value.get("call"))
            and isinstance(participants, list)
            and len(participants) == 2
            and all(_valid_participant(p) for p in participants)
        ):
            return value
    elif kind == "answer":
        if _has_exact_keys(value, {"type", "session_description"}) and _valid_description(
            value.get("session_description"), "answer"
        ):
            return value
    elif kind == "offer":
        if (
            _has_exact_keys(value, {"type", "session_description", "track"})
            and value.get("track") in ("audio", "video")
            and _valid_description(value.get("session_description"), "offer")
        ):
            return value
    elif kind == "ended":
        if _has_exact_keys(value, {"type", "reason"}) and value.get("reason") in TERMINAL_STATUSES:
            return value
    elif kind == "error":
        if (
            _has_exact_keys(value, {"type", "code", "message"})
            and value.get("code") in ROOM_ERROR_CODES
            and isinstance(value.get("message"), str)
        ):
            return value
    raise CallRoomError("Relay Call room received an invalid frame.")


def call_room_url(base_url: str, call_id: str) -> str:
    """``wss://<host>/v1/calls/<callId>/room`` from an ``https://`` API base URL."""
    parts = urlsplit(base_url.rstrip("/"))
    scheme = "wss" if parts.scheme == "https" else "ws"
    path = f"{parts.path.rstrip('/')}/v1/calls/{quote(call_id, safe='')}/room"
    return urlunsplit((scheme, parts.netloc, path, "", ""))


class _Attempt:
    def __init__(self, task: "asyncio.Task[None]") -> None:
        self.task = task


class CallRoom(rtc.EventEmitter[CallRoomEvent]):
    """Authenticated JSON signaling socket for one Relay Call participant.

    The room reopens its socket after any close that neither this client nor
    the server asked for, with PartySocket's numbers (PROTOCOL.md section 5):
    first retry after 3000 ms, then x1.3, capped at 10000 ms, a 4000 ms connect
    timeout, the retry count reset once a socket stays open 5000 ms, and no
    retry limit. On every open it sends ``join``, then ``userUpdate`` with the
    last muted/video state, then the frames queued while closed. Media is never
    re-offered by a socket-only reconnect.

    Events: ``open``, ``reconnecting`` (`CallRoomReconnectingEvent`),
    ``ice_servers`` (the room's ``iceServers`` frame, sent after every accepted
    ``join`` and before its ``roomState``), ``room_state``, ``offer``, ``answer``, ``ended``, ``error`` (a frame dict or
    an exception) and ``close`` (`CallRoomCloseEvent`, the socket closed and the
    room will not reopen it by itself).
    """

    def __init__(
        self,
        call_id: str,
        *,
        api_key: str,
        base_url: str = DEFAULT_BASE_URL,
        heartbeat_interval_ms: float = DEFAULT_HEARTBEAT_INTERVAL_MS,
        connector: Optional[RoomConnector] = None,
        _call_later: Optional[Callable[[float, Callable[[], None]], asyncio.Handle]] = None,
    ) -> None:
        super().__init__()
        if not call_id.strip():
            raise ValueError("call_id is required.")
        if not heartbeat_interval_ms > 0:
            raise ValueError("Call room heartbeat_interval_ms must be greater than zero.")
        self.call_id = call_id
        self.url = call_room_url(base_url, call_id)
        #: The last validated ``roomState`` frame.
        self.state: Optional[dict[str, Any]] = None
        #: The STUN/TURN servers of the room's latest ``iceServers`` frame, or
        #: ``None`` before the first. Relay sends fresh ones on every join,
        #: reconnects included, so read this again before each new peer.
        self.ice_servers: Optional[list[dict[str, Any]]] = None
        self._api_key = api_key
        self._connector: RoomConnector = connector or _websockets_connect
        self._heartbeat_interval_s = heartbeat_interval_ms / 1000
        self._call_later_override = _call_later
        # The open socket, or the still-open socket a manual `reconnect()` is replacing.
        self._socket: Optional[RoomSocket] = None
        self._outbox: Optional[asyncio.Queue[Optional[str]]] = None
        self._socket_tasks: list[asyncio.Task[None]] = []
        # The socket being opened, not yet accepted.
        self._attempt: Optional[_Attempt] = None
        self._heartbeat: Optional[asyncio.TimerHandle | asyncio.Handle] = None
        self._retry_timer: Optional[asyncio.TimerHandle | asyncio.Handle] = None
        self._uptime_timer: Optional[asyncio.TimerHandle | asyncio.Handle] = None
        # PartySocket `_retryCount`: -1 before the first connect, 0 once a socket stayed up.
        self._retry_count = -1
        self._closed = False
        self._ended = False
        self._connection_state: CallRoomConnectionState = "idle"
        self._queue: list[str] = []
        self._muted: Optional[bool] = None
        self._video: Optional[bool] = None
        self._open_waiters: list[asyncio.Future[None]] = []
        # The pending manual `reconnect()`, rejected alone when its attempt fails and the old socket is kept.
        self._manual: Optional[asyncio.Future[None]] = None

    @property
    def connection_state(self) -> CallRoomConnectionState:
        """``reconnecting`` while the room waits to reopen a dropped socket."""
        return self._connection_state

    def _later(self, delay_s: float, callback: Callable[[], None]) -> asyncio.Handle:
        if self._call_later_override is not None:
            return self._call_later_override(delay_s, callback)
        return asyncio.get_running_loop().call_later(delay_s, callback)

    async def connect(self) -> None:
        """Resolves on the first open; a failed attempt is retried, not raised."""
        if self._closed:
            raise CallRoomError("Relay Call room is closed.")
        if self._connection_state == "open":
            return
        if self._connection_state == "connecting":
            raise CallRoomError("Relay Call room is already connecting.")
        opened = self._wait_for_open()
        if self._connection_state == "idle":
            self._ended = False
            self._retry_count = -1
            self._connect()
        await opened

    async def reconnect(self) -> None:
        """Open a new signaling socket now, keeping application and WebRTC state alive.

        Relay accepts the new authenticated socket before the previous one
        closes. Same path as the automatic reconnect (PartySocket
        ``reconnect()``: retry count reset, no delay); if the new socket fails
        while the old one is still open, the old one stays and this raises.
        """
        if self._closed:
            raise CallRoomError("Relay Call room is closed.")
        manual: asyncio.Future[None] = asyncio.get_running_loop().create_future()
        self._open_waiters.append(manual)
        self._manual = manual
        self._ended = False
        self._retry_count = -1
        self._clear_retry_timer()
        self._abandon_attempt()
        self._connect()
        try:
            await manual
        finally:
            if self._manual is manual:
                self._manual = None

    def send(self, frame: dict[str, Any]) -> None:
        """Send one frame; while the socket is reopening it is queued and sent after ``join``.

        Heartbeats are dropped while closed, and ``userUpdate`` is re-sent from
        the recorded state on open rather than queued.
        """
        if self._closed or self._connection_state in ("idle", "closed"):
            raise CallRoomError("Relay Call room is not connected.")
        if frame.get("type") == "userUpdate":
            self._muted = bool(frame["muted"])
            if frame.get("video") is not None:
                self._video = bool(frame["video"])
        data = json.dumps(frame, separators=(",", ":"))
        if self._connection_state == "open" and self._socket is not None:
            self._write(data)
            return
        if frame.get("type") in ("heartbeat", "userUpdate"):
            return
        self._queue.append(data)

    def connected(self) -> None:
        self.send({"type": "connected"})

    def user_update(self, *, muted: bool, video: Optional[bool] = None) -> None:
        frame: dict[str, Any] = {"type": "userUpdate", "muted": muted}
        if video is not None:
            frame["video"] = video
        self.send(frame)

    def end(self) -> None:
        self.send({"type": "end"})

    def close(self, code: int = 1000, reason: str = "Client closed") -> None:
        if self._closed:
            return
        self._closed = True
        self._connection_state = "closed"
        self._stop_heartbeat()
        self._clear_retry_timer()
        self._clear_uptime_timer()
        self._abandon_attempt()
        self._queue = []
        socket = self._socket
        self._socket = None
        if socket is not None:
            self._close_socket(socket, code, reason)
        self._reject_open_waiters(CallRoomError("Relay Call room is closed."))

    def _abort_socket_for_test(self) -> None:
        """Drop the open socket without a close frame (the ladder's drop phase)."""
        socket: Any = self._socket
        transport = getattr(socket, "transport", None)
        if transport is not None:
            transport.abort()

    # ---- internals --------------------------------------------------------------------

    def _wait_for_open(self) -> "asyncio.Future[None]":
        future: asyncio.Future[None] = asyncio.get_running_loop().create_future()
        self._open_waiters.append(future)
        return future

    def _reject_open_waiters(self, error: BaseException) -> None:
        waiters, self._open_waiters = self._open_waiters, []
        for waiter in waiters:
            if not waiter.done():
                waiter.set_exception(error)
                # A waiter nobody awaits must not log "exception was never retrieved".
                waiter.exception()

    def next_delay_ms(self) -> float:
        """PartySocket ``_getNextDelay`` for the current retry count."""
        if self._retry_count <= 0:
            return 0
        return min(
            MIN_RECONNECTION_DELAY_MS * RECONNECTION_DELAY_GROW_FACTOR ** (self._retry_count - 1),
            MAX_RECONNECTION_DELAY_MS,
        )

    def _connect(self, close: Optional[CallRoomCloseEvent] = None, error: Optional[BaseException] = None) -> None:
        """PartySocket ``_connect``: count the attempt, wait the delay, open."""
        if self._closed:
            return
        self._retry_count += 1
        delay_ms = self.next_delay_ms()
        if self._socket is None:
            self._connection_state = "connecting" if self._retry_count == 0 else "reconnecting"
        else:
            self._connection_state = "connecting"
        if delay_ms == 0:
            self._open()
            return
        self.emit(
            "reconnecting",
            CallRoomReconnectingEvent(attempt=self._retry_count, delay_ms=delay_ms, close=close, error=error),
        )
        if self._closed:
            return

        def fire() -> None:
            self._retry_timer = None
            self._open()

        self._retry_timer = self._later(delay_ms / 1000, fire)

    def _open(self) -> None:
        if self._closed:
            return
        task = asyncio.get_running_loop().create_task(self._open_attempt())
        self._attempt = _Attempt(task)

    async def _open_attempt(self) -> None:
        attempt = self._attempt
        try:
            socket = await asyncio.wait_for(
                self._connector(self.url, {"Authorization": f"Bearer {self._api_key}"}),
                CONNECTION_TIMEOUT_MS / 1000,
            )
        except asyncio.CancelledError:
            raise
        except asyncio.TimeoutError:
            self._attempt_failed(attempt, CallRoomError("Relay Call room connect timed out."))
            return
        except Exception as error:  # noqa: BLE001 - every handshake failure is retried
            self._attempt_failed(attempt, CallRoomError(f"Relay Call room WebSocket failed to connect: {error}"))
            return
        if self._attempt is not attempt or self._closed:
            self._close_socket(socket, 1000, "Client closed")
            return
        self._attempt = None
        self._on_open(socket)

    def _attempt_failed(self, attempt: Optional[_Attempt], error: BaseException) -> None:
        if self._attempt is not attempt:
            return
        self._attempt = None
        if self._closed:
            return
        previous = self._socket
        manual = self._manual
        if previous is not None and manual is not None:
            # The socket a manual reconnect was replacing is still open: keep it.
            self._connection_state = "open"
            self._flush()
            self._manual = None
            self._open_waiters = [w for w in self._open_waiters if w is not manual]
            if not manual.done():
                manual.set_exception(error)
            return
        self._connect(error=error)

    def _on_open(self, socket: RoomSocket) -> None:
        previous = self._socket
        previous_outbox = self._outbox
        self._socket = socket
        self._connection_state = "open"
        self._outbox = asyncio.Queue()
        self._socket_tasks = [
            asyncio.get_running_loop().create_task(self._writer(socket, self._outbox)),
            asyncio.get_running_loop().create_task(self._reader(socket)),
        ]
        self._clear_uptime_timer()

        def uptime() -> None:
            self._uptime_timer = None
            self._retry_count = 0

        self._uptime_timer = self._later(MIN_UPTIME_MS / 1000, uptime)
        self._write(json.dumps({"type": "join"}))
        if self._muted is not None:
            update: dict[str, Any] = {"type": "userUpdate", "muted": self._muted}
            if self._video is not None:
                update["video"] = self._video
            self._write(json.dumps(update, separators=(",", ":")))
        self._flush()
        self._start_heartbeat()
        if previous is not None and previous is not socket:
            # Its reader ends on the close and is ignored: it is no longer `_socket`.
            if previous_outbox is not None:
                previous_outbox.put_nowait(None)
            self._close_socket(previous, 1000, "Replaced")
        waiters, self._open_waiters = self._open_waiters, []
        for waiter in waiters:
            if not waiter.done():
                waiter.set_result(None)
        self.emit("open")

    def _write(self, data: str) -> None:
        if self._outbox is not None:
            self._outbox.put_nowait(data)

    def _flush(self) -> None:
        queue, self._queue = self._queue, []
        for data in queue:
            self._write(data)

    async def _writer(self, socket: RoomSocket, outbox: "asyncio.Queue[Optional[str]]") -> None:
        while True:
            data = await outbox.get()
            if data is None:
                return
            try:
                await socket.send(data)
            except Exception:  # noqa: BLE001 - the reader sees the close and decides
                return

    def _close_socket(self, socket: RoomSocket, code: int, reason: str) -> None:
        async def run() -> None:
            try:
                await socket.close(code, reason)
            except Exception:  # noqa: BLE001 - late errors from sockets the room no longer uses
                pass

        asyncio.get_running_loop().create_task(run())

    def _abandon_attempt(self) -> None:
        attempt = self._attempt
        if attempt is None:
            return
        self._attempt = None
        attempt.task.cancel()

    def _is_final(self, event: CallRoomCloseEvent) -> bool:
        """A close the client or the server asked for, or the Call is over: never reopen."""
        if self._closed or self._ended:
            return True
        if event.code == CLIENT_PROTOCOL_ERROR:
            return True
        if event.code == 1000 and event.reason in ("Replaced", "Call ended"):
            return True
        status = (self.state or {}).get("call", {}).get("status")
        return status in TERMINAL_STATUSES

    async def _reader(self, socket: RoomSocket) -> None:
        while True:
            try:
                message = await socket.recv()
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 - ConnectionClosed and transport errors end the socket
                break
            if socket is not self._socket:
                continue
            try:
                self._message(message)
            except Exception as error:  # noqa: BLE001 - an invalid frame closes the socket
                if socket is not self._socket:
                    continue
                self.emit("error", error if isinstance(error, CallRoomError) else CallRoomError(str(error)))
                self._close_socket(socket, CLIENT_PROTOCOL_ERROR, "invalid frame")
        self._socket_closed(socket)

    def _socket_closed(self, socket: RoomSocket) -> None:
        if socket is not self._socket:
            return
        self._stop_heartbeat()
        self._clear_uptime_timer()
        if self._outbox is not None:
            self._outbox.put_nowait(None)
            self._outbox = None
        self._socket = None
        code = socket.close_code if socket.close_code is not None else 1006
        close = CallRoomCloseEvent(code=int(code), reason=socket.close_reason or "", was_clean=code != 1006)
        # A manual reconnect's new socket is still opening: the server closes the
        # socket it replaces ("Replaced"), and the new socket decides.
        if self._attempt is not None:
            self._connection_state = "connecting"
            return
        if not self._is_final(close):
            self._connect(close=close)
            return
        self._clear_retry_timer()
        self._abandon_attempt()
        self._queue = []
        if not self._closed:
            self._connection_state = "idle"
        self._reject_open_waiters(CallRoomError(f"Relay Call room closed ({close.code})."))
        self.emit("close", close)

    def _message(self, data: Union[str, bytes]) -> None:
        text = data.decode("utf-8") if isinstance(data, (bytes, bytearray)) else data
        frame = parse_call_room_server_frame(json.loads(text))
        if frame is None:
            return
        kind = frame["type"]
        if kind == "iceServers":
            self.ice_servers = frame["ice_servers"]
            self.emit("ice_servers", frame)
        elif kind == "roomState":
            self.state = frame
            self.emit("room_state", frame)
        elif kind == "offer":
            self.emit("offer", frame)
        elif kind == "answer":
            self.emit("answer", frame)
        elif kind == "ended":
            self._ended = True
            self.emit("ended", frame)
        elif kind == "error":
            self.emit("error", frame)

    def _start_heartbeat(self) -> None:
        self._stop_heartbeat()

        def beat() -> None:
            self._heartbeat = self._later(self._heartbeat_interval_s, beat)
            if self._connection_state != "open" or self._socket is None:
                return
            self._write('{"type":"heartbeat"}')

        self._heartbeat = self._later(self._heartbeat_interval_s, beat)

    def _stop_heartbeat(self) -> None:
        if self._heartbeat is not None:
            self._heartbeat.cancel()
            self._heartbeat = None

    def _clear_retry_timer(self) -> None:
        if self._retry_timer is not None:
            self._retry_timer.cancel()
            self._retry_timer = None

    def _clear_uptime_timer(self) -> None:
        if self._uptime_timer is not None:
            self._uptime_timer.cancel()
            self._uptime_timer = None
