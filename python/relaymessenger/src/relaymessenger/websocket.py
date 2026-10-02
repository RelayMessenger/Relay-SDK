"""The Agent WebSocket: the twin of ``relay.websocket.run`` in ``@relaymessenger/sdk``.

It follows packages/sdk/src/websocket.ts frame for frame. It connects to
``wss://<api host>/v1/websocket`` with the agent token (``connectAgentWebSocket``
in contracts/relay-v1-openapi.yaml), hands each event to ``on_event``, and sends
the cumulative ``ack`` only after ``on_event`` returns, so an event your handler
did not finish is delivered again on the next connection. It sends the text
heartbeat ``{"type":"ping"}`` every ``heartbeat_interval_ms`` and reconnects when
no ``pong`` comes back within 60 seconds; it answers a ``ping`` from Relay with
``pong``. A dropped connection reconnects with full-jitter exponential backoff
from 0.5 s to 30 s, reset by an acknowledged event; Relay replays every event
after the acknowledged checkpoint. A revoked token, a protocol error, or a webhook
subscription on the agent stops ``run`` with an error instead.

``on_event`` must be idempotent: deduplicate by ``event_id``. An event comes again
after a failed handler or a dropped connection, and when a handler outlives its
dropped connection by ``HANDLER_DRAIN_TIMEOUT`` (60 s) the next connection gets
the event while that first call may still run; its result is never acknowledged.

Stop it by cancelling the task that runs it.
"""

from __future__ import annotations

import asyncio
import inspect
import json
import logging
import random as _random
import re
from datetime import datetime
from typing import Any, Awaitable, Callable, Dict, Final, Literal, Optional, Set, TypedDict, Union
from urllib.parse import urlencode, urlsplit, urlunsplit

from .errors import RelayUnknownEventTypeError, RelayWebhookConfiguredError

#: Every event type this release knows, as ``RELAY_WEBHOOK_EVENT_TYPES`` in
#: packages/sdk/src/operations.ts. Another type is skipped and acknowledged.
RELAY_WEBHOOK_EVENT_TYPES: Final = (
    "message.sent",
    "message.received",
    "message.read",
    "message.delivered",
    "message.failed",
    "reaction.added",
    "reaction.removed",
    "participant.added",
    "participant.removed",
    "chat.created",
    "chat.group_name_updated",
    "chat.group_icon_updated",
    "chat.typing_indicator.started",
    "chat.typing_indicator.stopped",
    "contact.added",
    "contact.removed",
    "call.created",
    "call.updated",
    "call.ended",
    "payment.succeeded",
    "payment.canceled",
    "payment.expired",
    "location.sharing.started",
    "location.sharing.stopped",
    "rating.created",
    "rating.updated",
    "rating.deleted",
)

_WEBSOCKET_ERROR_CODES: Final = frozenset(
    {
        "invalid_frame",
        "ack_out_of_range",
        "stale_connection",
        "ack_failed",
        "delivery_failed",
        "full_sync_required",
        "full_sync_mismatch",
    }
)
_DISCONNECT_REASONS: Final = ("revoked", "heartbeat_timeout", "restart", "webhook_configured")
#: Seconds without a ``pong`` before the connection is dropped and reopened.
HEARTBEAT_PONG_TIMEOUT: float = 60.0
#: Seconds a dropped connection waits for the handler still running on it
#: before the next connection opens. Waiting keeps one event from running
#: twice at once; the bound keeps a handler that never returns from stopping
#: delivery for good. Past it, Relay sends the event again while the old call
#: may still run, which handlers already dedupe by event id.
HANDLER_DRAIN_TIMEOUT: float = 60.0
#: The exact heartbeat text Relay answers at the edge without waking the agent.
HEARTBEAT_PING_FRAME: Final = json.dumps({"type": "ping"}, separators=(",", ":"))
_CLOSE_DURABLE_ACCEPTANCE: Final = 4001
_CLOSE_PROTOCOL_ERROR: Final = 4002
_CLOSE_RECONNECT: Final = 4003
# `ws`, which the TypeScript SDK uses, accepts frames up to 100 MiB.
_MAX_FRAME_BYTES: Final = 100 * 1024 * 1024
_UPGRADE_BODY_LIMIT: Final = 65_536

#: The backoff wait between connections; a test replaces it to read the delays.
_sleep = asyncio.sleep

_SEQUENCE = re.compile(r"(0|[1-9][0-9]*)")
_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", re.IGNORECASE)


class WebSocketEventContext(TypedDict):
    #: The event's sequence, a decimal string.
    sequence: str


class WebSocketFullSyncContext(TypedDict):
    through_sequence: str
    reason: Literal["checkpoint_outside_retention"]


class WebSocketObservationGap(TypedDict):
    expected_sequence: str
    received_sequence: str


ConnectionState = Literal["connecting", "ready", "disconnected"]
EventHandler = Callable[[Dict[str, Any], WebSocketEventContext], Optional[Awaitable[None]]]
FullSyncHandler = Callable[[WebSocketFullSyncContext], Optional[Awaitable[None]]]


class WebSocketStoppedError(Exception):
    """Relay ended the connection for good (a revoked token, a refused upgrade,
    a fatal error frame); ``run`` raises it and does not reconnect."""

    def __init__(self, message: str, close_code: int = 1000) -> None:
        super().__init__(message)
        self.close_code = close_code


class WebSocketProtocolError(Exception):
    """Relay sent a frame this client cannot accept; ``run`` raises it and does not reconnect."""

    close_code = _CLOSE_PROTOCOL_ERROR


class _RetryableWebSocketError(Exception):
    def __init__(self, message: str, close_code: int = _CLOSE_RECONNECT) -> None:
        super().__init__(message)
        self.close_code = close_code


class _DurableApplicationError(Exception):
    close_code = _CLOSE_DURABLE_ACCEPTANCE

    def __init__(self, operation: str, cause: BaseException, sequence: Optional[str] = None) -> None:
        super().__init__(f"Relay WebSocket durable {operation} application failed: {cause}")
        #: Named in the close reason so Relay records the failure against this event.
        self.sequence = sequence


_logger = logging.getLogger("relaymessenger.websocket")


def _discard_result(task: "asyncio.Future[None]") -> None:
    """A handler that outlived its connection: its outcome is not delivered."""
    if not task.cancelled():
        task.exception()


def _is_heartbeat_answer(raw: Union[str, bytes]) -> bool:
    """The answer to this client's own heartbeat, read as it arrives rather than
    behind the event being handled: it proves the connection, not the handler,
    so a long handler keeps its connection (the SQS visibility-timeout
    extension; REL-428). Anything else goes to the ordered handler."""
    try:
        frame = json.loads(raw.decode("utf-8") if isinstance(raw, bytes) else raw)
        if not isinstance(frame, dict) or frame.get("type") != "pong":
            return False
        _parse_pong(frame)
        return True
    except (ValueError, UnicodeDecodeError, WebSocketProtocolError):
        return False


_STOPPING = (WebSocketStoppedError, WebSocketProtocolError, RelayWebhookConfiguredError)


def _has_exact_keys(value: Dict[str, Any], keys: tuple[str, ...]) -> bool:
    return sorted(value) == sorted(keys)


def _valid_sequence(value: Any) -> bool:
    return isinstance(value, str) and _SEQUENCE.fullmatch(value) is not None


def _valid_uuid(value: Any) -> bool:
    return isinstance(value, str) and _UUID.fullmatch(value) is not None


def _positive_integer(value: Any) -> bool:
    if isinstance(value, bool):
        return False
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    return isinstance(value, int) and value >= 1


def _parse_ready(value: Dict[str, Any]) -> Dict[str, Any]:
    keys = (
        "type",
        "connection_id",
        "acked_through",
        "full_sync_required",
        "full_sync_through",
        "heartbeat_interval_ms",
        "max_in_flight",
    ) + (("observational",) if "observational" in value else ())
    required = value.get("full_sync_required")
    if (
        not _has_exact_keys(value, keys)
        or value["type"] != "ready"
        or ("observational" in value and value["observational"] is not True)
        or not _valid_uuid(value["connection_id"])
        or not _valid_sequence(value["acked_through"])
        or not isinstance(required, bool)
        or (not _valid_sequence(value["full_sync_through"]) if required else value["full_sync_through"] is not None)
        or not _positive_integer(value["heartbeat_interval_ms"])
        or not _positive_integer(value["max_in_flight"])
    ):
        raise WebSocketProtocolError("Relay WebSocket received an invalid ready frame.")
    return value


def _parse_event(value: Dict[str, Any]) -> bool:
    """Checks an event frame; returns whether this release knows its type."""
    event = value.get("event")
    if (
        not _has_exact_keys(value, ("type", "sequence", "event"))
        or value["type"] != "event"
        or not _valid_sequence(value["sequence"])
        or not isinstance(event, dict)
        or event.get("api_version") != "v1"
        or event.get("webhook_version") != "2026-08-30"
        or not isinstance(event.get("event_type"), str)
        or not event["event_type"]
        or not _valid_uuid(event.get("event_id"))
        or not isinstance(event.get("created_at"), str)
        or not isinstance(event.get("trace_id"), str)
        or not _valid_uuid(event.get("agent_id"))
        or not isinstance(event.get("data"), dict)
    ):
        raise WebSocketProtocolError("Relay WebSocket received an invalid event frame.")
    return event["event_type"] in RELAY_WEBHOOK_EVENT_TYPES


def _parse_full_sync(value: Dict[str, Any]) -> Dict[str, Any]:
    if (
        not _has_exact_keys(value, ("type", "through_sequence", "reason"))
        or value["type"] != "full_sync"
        or not _valid_sequence(value["through_sequence"])
        or value["reason"] != "checkpoint_outside_retention"
    ):
        raise WebSocketProtocolError("Relay WebSocket received an invalid FULL sync frame.")
    return value


def _valid_timestamp(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return False
    return True


def _parse_ping(value: Dict[str, Any]) -> None:
    if not _has_exact_keys(value, ("type", "sent_at")) or not _valid_timestamp(value["sent_at"]):
        raise WebSocketProtocolError("Relay WebSocket received an invalid ping frame.")


def _parse_pong(value: Dict[str, Any]) -> None:
    if not _has_exact_keys(value, ("type",)):
        raise WebSocketProtocolError("Relay WebSocket received an invalid pong frame.")


def _parse_error(value: Dict[str, Any]) -> Dict[str, Any]:
    if (
        not _has_exact_keys(value, ("type", "code", "message", "fatal", "retryable"))
        or value["code"] not in _WEBSOCKET_ERROR_CODES
        or not isinstance(value["message"], str)
        or not isinstance(value["fatal"], bool)
        or not isinstance(value["retryable"], bool)
    ):
        raise WebSocketProtocolError("Relay WebSocket received an invalid error frame.")
    return value


def _parse_disconnect(value: Dict[str, Any]) -> str:
    if not _has_exact_keys(value, ("type", "reason")) or value["reason"] not in _DISCONNECT_REASONS:
        raise WebSocketProtocolError("Relay WebSocket received an invalid disconnect frame.")
    return str(value["reason"])


def _upgrade_error(status: int, reason_phrase: str, text: str) -> Exception:
    body: Any = text
    message: Optional[str] = None
    trace_id: Optional[str] = None
    try:
        parsed = json.loads(text) if text else None
        body = parsed
        if isinstance(parsed, dict):
            if isinstance(parsed.get("trace_id"), str):
                trace_id = parsed["trace_id"]
            error = parsed.get("error")
            if isinstance(error, dict) and isinstance(error.get("message"), str):
                message = error["message"]
    except ValueError:
        pass
    if status == 409:
        return RelayWebhookConfiguredError(
            message or "This Agent delivers by webhook; delete its webhook subscription to use the WebSocket.",
            trace_id=trace_id,
            body=body,
        )
    fallback = (
        f"Relay WebSocket upgrade failed with HTTP {status}{f' {reason_phrase}' if reason_phrase else ''}."
        if status > 0
        else "Relay WebSocket upgrade failed before receiving an HTTP status."
    )
    if status == 429 or status >= 500 or status == 0:
        return _RetryableWebSocketError(message or fallback)
    return WebSocketStoppedError(message or fallback)


def websocket_url(base_url: str, observe: bool = False) -> str:
    """``wss://<host>/v1/websocket`` for an ``https://`` base URL (``ws://`` for ``http://``).

    Relay sends a connection only the event types it names in
    ``subscribed_events``, and every type, including ones added later, when it
    names none. This names every type this release knows, so a newer type it
    cannot decode is never sent to it.
    """
    parts = urlsplit(base_url)
    if parts.scheme not in ("http", "https") or not parts.hostname or parts.username or parts.password:
        raise TypeError("Relay base_url must be an absolute HTTP(S) URL.")
    scheme = "wss" if parts.scheme == "https" else "ws"
    query = [("observe", "true")] if observe else []
    query += [("subscribed_events", event_type) for event_type in RELAY_WEBHOOK_EVENT_TYPES]
    return urlunsplit((scheme, parts.netloc, "/v1/websocket", urlencode(query), ""))


async def _settle(result: Optional[Awaitable[None]]) -> None:
    if inspect.isawaitable(result):
        await result


class _Connection:
    """One connection, from the upgrade to its close (``runConnection`` in websocket.ts)."""

    def __init__(
        self,
        url: str,
        agent_token: str,
        user_agent: str,
        on_event: EventHandler,
        on_full_sync: FullSyncHandler,
        observe: bool,
        on_ready: Callable[[Dict[str, Any]], None],
        on_unknown_event: Callable[[str, str], None],
        on_observation_gap: Optional[Callable[[WebSocketObservationGap], None]],
        on_acknowledged: Callable[[], None] = lambda: None,
    ) -> None:
        self.url = url
        self.agent_token = agent_token
        self.user_agent = user_agent
        self.on_event = on_event
        self.on_full_sync = on_full_sync
        self.observe = observe
        self.on_ready = on_ready
        self.on_unknown_event = on_unknown_event
        self.on_observation_gap = on_observation_gap
        self.on_acknowledged = on_acknowledged
        self.ready = False
        self.accepted_through = 0
        self.full_sync_through: Optional[int] = None
        self.last_pong = 0.0
        #: Set by the heartbeat when it drops the connection.
        self.failure: Optional[Exception] = None
        #: Set once the connection is gone, by the heartbeat or by the peer.
        self._dropped = asyncio.Event()
        self.socket: Any = None
        #: Seconds between heartbeats, from the ready frame.
        self._interval = 30.0

    async def run(self) -> None:
        from websockets.asyncio.client import connect
        from websockets.exceptions import ConnectionClosed, InvalidHandshake, InvalidStatus

        try:
            self.socket = await connect(
                self.url,
                additional_headers={"Authorization": f"Bearer {self.agent_token}"},
                user_agent_header=self.user_agent,
                # Relay's heartbeat is the text ping below, as in the TypeScript SDK.
                ping_interval=None,
                max_size=_MAX_FRAME_BYTES,
            )
        except InvalidStatus as error:
            response = error.response
            text = (response.body or b"")[:_UPGRADE_BODY_LIMIT].decode("utf-8", "replace")
            raise _upgrade_error(response.status_code, response.reason_phrase, text) from None
        except (OSError, asyncio.TimeoutError, InvalidHandshake) as error:
            raise _RetryableWebSocketError("Relay WebSocket connection failed.") from error

        socket = self.socket
        heartbeat: Optional[asyncio.Task[None]] = None
        # One reader takes every frame off the socket as it arrives; the
        # handler takes the rest in order. When the connection drops, the
        # handler still running finishes before this returns, so the next
        # connection, which Relay sends every unacknowledged event again, never
        # runs one event twice at the same time (REL-428).
        frames: asyncio.Queue[Union[str, bytes, BaseException, None]] = asyncio.Queue()

        async def read() -> None:
            try:
                async for raw in socket:
                    if _is_heartbeat_answer(raw):
                        self.last_pong = asyncio.get_running_loop().time()
                        continue
                    frames.put_nowait(raw)
            except ConnectionClosed:
                pass
            except Exception as error:
                frames.put_nowait(error)
            finally:
                self._dropped.set()
                frames.put_nowait(None)

        reader = asyncio.create_task(read())
        try:
            try:
                while True:
                    raw = await frames.get()
                    if raw is None:
                        break
                    if isinstance(raw, BaseException):
                        raise raw
                    # A connection that is gone, however it ended (the heartbeat,
                    # a peer close, an error), runs none of the frames still
                    # buffered on it: Relay sends them again on the next one.
                    if self.failure is not None or self._dropped.is_set():
                        break
                    if await self._handle_within_drain(raw):
                        break
                    if heartbeat is None and self.ready:
                        heartbeat = asyncio.create_task(self._heartbeat(self._interval))
            except ConnectionClosed:
                pass
            except Exception as error:
                if self.failure is not None:
                    raise self.failure from None
                code = getattr(error, "close_code", _CLOSE_DURABLE_ACCEPTANCE)
                reason = (
                    "Relay stopped this consumer"
                    if isinstance(error, WebSocketStoppedError)
                    else "protocol error"
                    if isinstance(error, WebSocketProtocolError)
                    else "Relay requested reconnect"
                    if isinstance(error, _RetryableWebSocketError)
                    else f"durable application failed at sequence {error.sequence}"
                    if isinstance(error, _DurableApplicationError) and error.sequence is not None
                    else "durable application failed"
                )
                await socket.close(code, reason)
                raise
        finally:
            reader.cancel()
            if heartbeat is not None:
                heartbeat.cancel()
            await socket.close()

        if self.failure is not None:
            raise self.failure
        code = socket.close_code
        reason = socket.close_reason or ""
        if code == 4410:
            raise RelayWebhookConfiguredError(
                reason or "Webhook delivery is now configured for this Agent.",
                code=4410,
                body={"close_code": 4410, "reason": reason},
            )
        if code is not None and 4400 <= code <= 4499 and code != 4408:
            raise WebSocketStoppedError(
                f"Relay WebSocket closed permanently ({code}): {reason or 'server policy changed'}.", code
            )
        if not self.ready:
            raise _RetryableWebSocketError(
                f"Relay WebSocket closed before ready ({code or 1006}): {reason or 'connection ended'}."
            )

    async def _handle_within_drain(self, raw: Union[str, bytes]) -> bool:
        """Handles one frame. Once the connection is gone, waits for the handler
        at most HANDLER_DRAIN_TIMEOUT; True when it outlived that, and is left
        running with its result never acknowledged (REL-428 review)."""
        handling = asyncio.ensure_future(self._handle(raw))
        dropped = asyncio.ensure_future(self._dropped.wait())
        try:
            await asyncio.wait({handling, dropped}, return_when=asyncio.FIRST_COMPLETED)
            if not handling.done():
                await asyncio.wait({handling}, timeout=HANDLER_DRAIN_TIMEOUT)
            if not handling.done():
                handling.add_done_callback(_discard_result)
                return True
        finally:
            dropped.cancel()
        handling.result()
        return False

    async def _heartbeat(self, interval: float) -> None:
        # A text frame, not a protocol ping, which Relay answers from the edge
        # without waking the agent.
        loop = asyncio.get_running_loop()
        while True:
            await asyncio.sleep(interval)
            if loop.time() - self.last_pong >= HEARTBEAT_PONG_TIMEOUT:
                self.failure = _RetryableWebSocketError(
                    f"Relay WebSocket did not receive a pong within {HEARTBEAT_PONG_TIMEOUT:g} seconds."
                )
                self._dropped.set()
                await self.socket.close(_CLOSE_RECONNECT, "Relay requested reconnect")
                return
            try:
                await self.socket.send(HEARTBEAT_PING_FRAME)
            except Exception as error:
                self.failure = _RetryableWebSocketError(f"Relay WebSocket ping failed: {error}")
                self._dropped.set()
                await self.socket.close(_CLOSE_RECONNECT, "Relay requested reconnect")
                return

    async def _send(self, frame: Dict[str, Any]) -> None:
        try:
            await self.socket.send(json.dumps(frame, separators=(",", ":")))
        except Exception as error:
            raise _RetryableWebSocketError(f"Relay WebSocket could not send a client frame: {error}") from error

    async def _handle(self, raw: Union[str, bytes]) -> None:
        try:
            frame = json.loads(raw.decode("utf-8") if isinstance(raw, bytes) else raw)
        except UnicodeDecodeError:
            raise WebSocketProtocolError("Relay WebSocket received a non-text frame.") from None
        except ValueError:
            raise WebSocketProtocolError("Relay WebSocket received invalid JSON.") from None
        kind = frame.get("type") if isinstance(frame, dict) else None

        if kind == "ready":
            if self.ready:
                raise WebSocketProtocolError("Relay WebSocket received more than one ready frame.")
            ready = _parse_ready(frame)
            observational = ready.get("observational") is True
            if self.observe and not observational:
                raise WebSocketStoppedError(
                    "Server did not confirm read-only observation; no consuming fallback was opened."
                )
            if not self.observe and observational:
                raise WebSocketProtocolError("Unexpected observation mode on a consuming connection.")
            if self.observe and (ready["full_sync_required"] or ready["full_sync_through"] is not None):
                raise WebSocketProtocolError("Read-only observation must not require FULL sync.")
            self.ready = True
            self.accepted_through = int(ready["acked_through"])
            self.full_sync_through = int(ready["full_sync_through"]) if ready["full_sync_required"] else None
            self.last_pong = asyncio.get_running_loop().time()
            self._interval = int(ready["heartbeat_interval_ms"]) / 1000
            self.on_ready(ready)
            return
        if kind == "disconnect":
            reason = _parse_disconnect(frame)
            if reason in ("heartbeat_timeout", "restart"):
                raise _RetryableWebSocketError(
                    "Relay WebSocket is restarting." if reason == "restart" else "Relay WebSocket heartbeat timed out."
                )
            if reason == "webhook_configured":
                raise RelayWebhookConfiguredError("Webhook delivery is now configured for this Agent.", code=4410)
            raise WebSocketStoppedError(f"Relay WebSocket disconnected permanently: {reason}.", 4401)
        if kind == "ping":
            if not self.ready:
                raise WebSocketProtocolError("Relay WebSocket received a ping before the ready frame.")
            _parse_ping(frame)
            await self._send({"type": "pong"})
            return
        if kind == "pong":
            # The answer to this client's own heartbeat.
            _parse_pong(frame)
            self.last_pong = asyncio.get_running_loop().time()
            return
        if kind == "error":
            error = _parse_error(frame)
            if not error["retryable"]:
                raise WebSocketStoppedError(error["message"])
            raise _RetryableWebSocketError(error["message"])
        if not self.ready:
            raise WebSocketProtocolError("Relay WebSocket received a data frame before the ready frame.")
        if kind == "full_sync":
            full_sync = _parse_full_sync(frame)
            if self.full_sync_through is None or int(full_sync["through_sequence"]) != self.full_sync_through:
                raise WebSocketProtocolError("Relay WebSocket FULL sync did not match the ready checkpoint.")
            if self.observe:
                raise WebSocketStoppedError(
                    "Observation stopped: a consuming runtime must complete FULL sync; no completion was sent."
                )
            try:
                await _settle(
                    self.on_full_sync(
                        {"through_sequence": full_sync["through_sequence"], "reason": full_sync["reason"]}
                    )
                )
            except Exception as cause:
                raise _DurableApplicationError("FULL sync", cause) from cause
            await self._send({"type": "full_sync_complete", "through_sequence": full_sync["through_sequence"]})
            self.accepted_through = self.full_sync_through
            self.full_sync_through = None
            self.on_acknowledged()
            return
        if self.full_sync_through is not None:
            raise WebSocketProtocolError("Relay WebSocket received an event while FULL sync was pending.")

        known = _parse_event(frame)
        event: Dict[str, Any] = frame["event"]
        sequence_text: str = frame["sequence"]
        sequence = int(sequence_text)
        if self.observe and sequence <= self.accepted_through:
            raise WebSocketProtocolError("Observer event sequences must increase on each connection.")
        if sequence > self.accepted_through + 1:
            if not self.observe:
                raise WebSocketProtocolError("Relay WebSocket received a non-contiguous event sequence.")
            if self.on_observation_gap is not None:
                self.on_observation_gap(
                    {"expected_sequence": str(self.accepted_through + 1), "received_sequence": sequence_text}
                )
        if known:
            try:
                await _settle(self.on_event(event, {"sequence": sequence_text}))
            except Exception as cause:
                raise _DurableApplicationError("event", cause, sequence_text) from cause
        else:
            # Skipped, then acknowledged below exactly like a handled event.
            self.on_unknown_event(event["event_type"], sequence_text)
        if self.observe:
            # Local observation progress, not the server's checkpoint.
            if sequence > self.accepted_through:
                self.accepted_through = sequence
            return
        if sequence == self.accepted_through + 1:
            self.accepted_through = sequence
        if self._dropped.is_set():
            # Too late for this connection; Relay sends the event again.
            return
        await self._send({"type": "ack", "through_sequence": str(self.accepted_through)})
        self.on_acknowledged()


async def run_websocket(
    base_url: str,
    agent_token: str,
    *,
    on_event: EventHandler,
    on_full_sync: FullSyncHandler,
    observe: bool = False,
    on_connection_state: Optional[Callable[[ConnectionState], None]] = None,
    on_ready: Optional[Callable[[Dict[str, Any]], None]] = None,
    on_observation_gap: Optional[Callable[[WebSocketObservationGap], None]] = None,
    on_error: Optional[Callable[[Exception], None]] = None,
    min_reconnect_delay: float = 0.5,
    max_reconnect_delay: float = 30.0,
    random: Callable[[], float] = _random.random,
    user_agent: Optional[str] = None,
) -> None:
    """Keeps one Agent WebSocket connection open until the task is cancelled
    (``runWebSocket`` in websocket.ts). See :meth:`WebSocket.run`."""
    if not isinstance(observe, bool):
        raise TypeError("WebSocket observe must be a boolean.")
    if min_reconnect_delay < 0 or max_reconnect_delay < min_reconnect_delay or max_reconnect_delay == float("inf"):
        raise ValueError(
            "WebSocket reconnect delays must be finite and max_reconnect_delay must be at least min_reconnect_delay."
        )
    if not agent_token.strip():
        raise TypeError("A Relay Agent Token is required for WebSocket delivery.")
    if user_agent is None:
        from .client import USER_AGENT

        user_agent = USER_AGENT
    url = websocket_url(base_url, observe)
    # A failure nobody is told about is a failure nobody fixes: without
    # on_error, log it (REL-427).
    report: Callable[[Exception], None] = on_error or (
        lambda error: _logger.error("Relay WebSocket: %s", error, exc_info=error)
    )
    attempt = 0
    # True from a handler failure until an event is acknowledged again. While
    # it holds, a new connection's ready frame does not reset the backoff, so a
    # handler that keeps failing is retried at 0.5, 1, 2 ... 30 s, not twice a
    # second (REL-427).
    failing = False
    # Each unknown event type is reported once per run, so on_error is not flooded.
    reported_unknown: Set[str] = set()

    def unknown_event(event_type: str, sequence: str) -> None:
        if event_type in reported_unknown:
            return
        reported_unknown.add(event_type)
        report(RelayUnknownEventTypeError(event_type, sequence))

    def ready(frame: Dict[str, Any]) -> None:
        nonlocal attempt
        if not failing:
            attempt = 0
        if on_connection_state is not None:
            on_connection_state("ready")
        if on_ready is not None:
            on_ready(frame)

    def acknowledged() -> None:
        nonlocal attempt, failing
        failing = False
        attempt = 0

    while True:
        if on_connection_state is not None:
            on_connection_state("connecting")
        try:
            await _Connection(
                url,
                agent_token,
                user_agent,
                on_event,
                on_full_sync,
                observe,
                ready,
                unknown_event,
                on_observation_gap,
                acknowledged,
            ).run()
        except _STOPPING as error:
            report(error)
            raise
        except Exception as error:
            report(error)
            if isinstance(error, _DurableApplicationError):
                failing = True
            attempt += 1
        finally:
            if on_connection_state is not None:
                on_connection_state("disconnected")
        ceiling = min(max_reconnect_delay, min_reconnect_delay * 2 ** max(0, attempt - 1))
        await _sleep(random() * ceiling)


class WebSocket:
    """``relay.websocket``: receive the agent's events over the Agent WebSocket."""

    def __init__(self, base_url: str, api_key: str) -> None:
        self._base_url = base_url
        self._api_key = api_key

    async def run(
        self,
        *,
        on_event: EventHandler,
        on_full_sync: FullSyncHandler,
        observe: bool = False,
        on_connection_state: Optional[Callable[[ConnectionState], None]] = None,
        on_ready: Optional[Callable[[Dict[str, Any]], None]] = None,
        on_observation_gap: Optional[Callable[[WebSocketObservationGap], None]] = None,
        on_error: Optional[Callable[[Exception], None]] = None,
        min_reconnect_delay: float = 0.5,
        max_reconnect_delay: float = 30.0,
        random: Callable[[], float] = _random.random,
    ) -> None:
        """Keeps one outbound WebSocket connection open until the task is cancelled.

        ``on_event(event, context)`` gets each event envelope, the same one a
        webhook delivers, and ``context["sequence"]``. It may be a plain
        function or a coroutine function. Return only after the event is safe
        in your own store: the SDK then sends the cumulative ``ack``, and an
        event whose handler raised is delivered again after a reconnect. The
        ack changes no Delivered or Read receipt.

        ``on_full_sync(context)`` runs when Relay no longer holds the events
        after your checkpoint: replace your local state with a complete REST
        snapshot through ``context["through_sequence"]``, then return. An
        agent with no local state can simply return.

        ``on_error`` gets each connection failure before its reconnect, and a
        :class:`RelayUnknownEventTypeError` the first time an event type this
        release does not know arrives (it is skipped and acknowledged). Without
        ``on_error``, each is logged on the ``relaymessenger.websocket`` logger.
        When ``on_event`` raises, the event comes back on the next connection,
        after a delay that doubles from ``min_reconnect_delay`` to
        ``max_reconnect_delay`` until an event is acknowledged again.
        ``run`` raises, and stops, on a :class:`WebSocketStoppedError`, a
        :class:`WebSocketProtocolError`, or a
        :class:`RelayWebhookConfiguredError` (the agent has a webhook
        subscription; delete it to use the WebSocket).

        ``observe=True`` opens the read-only watch mode (``?observe=true``):
        it sends no ``ack``, never falls back to the consuming mode, and is
        not a way to rebuild state.
        """
        await run_websocket(
            self._base_url,
            self._api_key,
            on_event=on_event,
            on_full_sync=on_full_sync,
            observe=observe,
            on_connection_state=on_connection_state,
            on_ready=on_ready,
            on_observation_gap=on_observation_gap,
            on_error=on_error,
            min_reconnect_delay=min_reconnect_delay,
            max_reconnect_delay=max_reconnect_delay,
            random=random,
        )


__all__ = [
    "HEARTBEAT_PING_FRAME",
    "RELAY_WEBHOOK_EVENT_TYPES",
    "ConnectionState",
    "WebSocket",
    "WebSocketEventContext",
    "WebSocketFullSyncContext",
    "WebSocketObservationGap",
    "WebSocketProtocolError",
    "WebSocketStoppedError",
    "run_websocket",
    "websocket_url",
]
