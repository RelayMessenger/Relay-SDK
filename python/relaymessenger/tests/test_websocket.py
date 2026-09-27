"""The Agent WebSocket against a local WebSocket server that speaks Relay's
frames (Relay-Docs websocket/protocol.mdx, contracts/relay-v1-openapi.yaml
``connectAgentWebSocket``), checking the rules packages/sdk/src/websocket.ts
follows: the ack only after the handler returns, the pong for Relay's ping,
the text heartbeat and its 60-second pong deadline, replay after a failed
handler, and the reconnect backoff."""

from __future__ import annotations

import asyncio
import json
import re
from http import HTTPStatus
from pathlib import Path
from typing import Any, AsyncIterator, Awaitable, Callable, Dict, List, Optional, Tuple

import pytest
from websockets.asyncio.server import Server, ServerConnection, serve
from websockets.http11 import Request, Response

from relaymessenger import (
    Relay,
    RelayUnknownEventTypeError,
    RelayWebhookConfiguredError,
    WebSocketProtocolError,
    WebSocketStoppedError,
    websocket,
)
from relaymessenger.client import USER_AGENT
from relaymessenger.websocket import RELAY_WEBHOOK_EVENT_TYPES, websocket_url

Script = Callable[[ServerConnection], Awaitable[None]]
AGENT = "01a05223-bd8e-7619-8a44-b7e2069a226f"
CONNECTION = "01a05223-bd8e-7619-8a44-b7e2069a2270"


def ready(acked: str = "0", *, interval_ms: int = 30_000, full_sync_through: Optional[str] = None) -> str:
    return json.dumps(
        {
            "type": "ready",
            "connection_id": CONNECTION,
            "acked_through": acked,
            "full_sync_required": full_sync_through is not None,
            "full_sync_through": full_sync_through,
            "heartbeat_interval_ms": interval_ms,
            "max_in_flight": 16,
        }
    )


def event(sequence: int, event_type: str = "message.received", text: str = "hi") -> str:
    return json.dumps(
        {
            "type": "event",
            "sequence": str(sequence),
            "event": {
                "api_version": "v1",
                "webhook_version": "2026-08-30",
                "event_type": event_type,
                "event_id": f"01a08e1e-e134-708b-afba-7e76c55678{sequence:02d}",
                "created_at": "2026-09-27T00:00:00.000Z",
                "trace_id": "c86014b4778f3b556008a9e2a61a06fd",
                "agent_id": AGENT,
                "data": {"chat": {"id": "c1"}, "parts": [{"type": "text", "value": text}]},
            },
        }
    )


async def recv(connection: ServerConnection, timeout: float = 2.0) -> Any:
    return json.loads(await asyncio.wait_for(connection.recv(), timeout))


async def closed(connection: ServerConnection) -> Optional[int]:
    """Waits for the client to close; returns its close code."""
    await asyncio.wait_for(connection.wait_closed(), 2.0)
    return connection.close_code


class FakeRelay:
    """Runs one script per connection, in order, or refuses the upgrade with a queued status."""

    def __init__(self) -> None:
        self.scripts: List[Script] = []
        self.refusals: List[Tuple[int, str]] = []
        self.requests: List[Request] = []
        self.server: Optional[Server] = None

    @property
    def base_url(self) -> str:
        assert self.server is not None
        port = next(iter(self.server.sockets)).getsockname()[1]
        return f"http://127.0.0.1:{port}"

    def _process(self, connection: ServerConnection, request: Request) -> Optional[Response]:
        self.requests.append(request)
        if self.refusals:
            status, body = self.refusals.pop(0)
            return connection.respond(HTTPStatus(status), body)
        return None

    async def _handle(self, connection: ServerConnection) -> None:
        script = self.scripts.pop(0) if self.scripts else _hold
        await script(connection)

    async def start(self) -> None:
        self.server = await serve(self._handle, "127.0.0.1", 0, process_request=self._process)

    async def stop(self) -> None:
        assert self.server is not None
        self.server.close()
        await self.server.wait_closed()


async def _hold(connection: ServerConnection) -> None:
    await connection.send(ready())
    await connection.wait_closed()


@pytest.fixture
async def relay_server() -> AsyncIterator[FakeRelay]:
    server = FakeRelay()
    await server.start()
    yield server
    await server.stop()


async def run_until(
    relay_server: FakeRelay, finished: "asyncio.Future[Any]", **options: Any
) -> "asyncio.Task[None]":
    relay = Relay("agent-token", base_url=relay_server.base_url)
    options.setdefault("on_full_sync", lambda context: None)
    options.setdefault("random", lambda: 0.0)
    task = asyncio.create_task(relay.websocket.run(**options))
    try:
        await asyncio.wait_for(asyncio.shield(finished), 5.0)
    finally:
        task.cancel()
        try:
            await task
        except (asyncio.CancelledError, Exception):
            pass
    return task


async def test_it_connects_with_the_token_and_acks_only_after_the_handler_returns(relay_server: FakeRelay) -> None:
    release = asyncio.Event()
    handled: List[Tuple[str, str]] = []
    finished: asyncio.Future[Any] = asyncio.get_running_loop().create_future()

    async def script(connection: ServerConnection) -> None:
        await connection.send(ready("4"))
        await connection.send(event(5))
        # The handler is still running: no ack yet.
        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(connection.recv(), 0.3)
        release.set()
        finished.set_result(await recv(connection))

    async def on_event(envelope: Dict[str, Any], context: Dict[str, str]) -> None:
        await release.wait()
        handled.append((envelope["event_type"], context["sequence"]))

    relay_server.scripts.append(script)
    await run_until(relay_server, finished, on_event=on_event)
    assert finished.result() == {"type": "ack", "through_sequence": "5"}
    assert handled == [("message.received", "5")]
    request = relay_server.requests[0]
    assert request.path == "/v1/websocket"
    assert request.headers["Authorization"] == "Bearer agent-token"
    assert request.headers["User-Agent"] == USER_AGENT


async def test_it_answers_relays_ping_with_pong(relay_server: FakeRelay) -> None:
    finished: asyncio.Future[Any] = asyncio.get_running_loop().create_future()

    async def script(connection: ServerConnection) -> None:
        await connection.send(ready())
        await connection.send(json.dumps({"type": "ping", "sent_at": "2026-09-27T00:00:00.000Z"}))
        finished.set_result(await recv(connection))

    relay_server.scripts.append(script)
    await run_until(relay_server, finished, on_event=lambda e, c: None)
    assert finished.result() == {"type": "pong"}


async def test_it_sends_the_exact_text_heartbeat_every_interval(relay_server: FakeRelay) -> None:
    finished: asyncio.Future[Any] = asyncio.get_running_loop().create_future()

    async def script(connection: ServerConnection) -> None:
        await connection.send(ready(interval_ms=50))
        frames = []
        for _ in range(3):
            frames.append(await asyncio.wait_for(connection.recv(), 2.0))
            await connection.send(json.dumps({"type": "pong"}))
        finished.set_result(frames)

    relay_server.scripts.append(script)
    await run_until(relay_server, finished, on_event=lambda e, c: None)
    assert finished.result() == ['{"type":"ping"}'] * 3


async def test_no_pong_within_the_deadline_closes_4003_and_reconnects(
    relay_server: FakeRelay, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(websocket, "HEARTBEAT_PONG_TIMEOUT", 0.2)
    codes: List[Optional[int]] = []
    finished: asyncio.Future[Any] = asyncio.get_running_loop().create_future()
    errors: List[Exception] = []

    async def silent(connection: ServerConnection) -> None:
        await connection.send(ready(interval_ms=50))
        codes.append(await closed(connection))

    async def second(connection: ServerConnection) -> None:
        finished.set_result(None)
        await connection.wait_closed()

    relay_server.scripts += [silent, second]
    await run_until(relay_server, finished, on_event=lambda e, c: None, on_error=errors.append)
    assert codes == [4003]
    assert "did not receive a pong within 0.2 seconds" in str(errors[0])


async def test_a_failed_handler_closes_4001_sends_no_ack_and_the_event_is_replayed(relay_server: FakeRelay) -> None:
    calls: List[str] = []
    codes: List[Optional[int]] = []
    finished: asyncio.Future[Any] = asyncio.get_running_loop().create_future()

    async def first(connection: ServerConnection) -> None:
        await connection.send(ready("0"))
        await connection.send(event(1))
        codes.append(await closed(connection))

    async def second(connection: ServerConnection) -> None:
        await connection.send(ready("0"))
        await connection.send(event(1))
        finished.set_result(await recv(connection))

    def on_event(envelope: Dict[str, Any], context: Dict[str, str]) -> None:
        calls.append(context["sequence"])
        if len(calls) == 1:
            raise RuntimeError("inbox is down")

    relay_server.scripts += [first, second]
    await run_until(relay_server, finished, on_event=on_event)
    assert codes == [4001]
    assert calls == ["1", "1"]
    assert finished.result() == {"type": "ack", "through_sequence": "1"}


async def test_an_unknown_event_type_is_skipped_acked_and_reported_once(relay_server: FakeRelay) -> None:
    handled: List[str] = []
    errors: List[Exception] = []
    finished: asyncio.Future[Any] = asyncio.get_running_loop().create_future()

    async def script(connection: ServerConnection) -> None:
        await connection.send(ready())
        acks = []
        for sequence, kind in ((1, "future.thing"), (2, "future.thing"), (3, "message.received")):
            await connection.send(event(sequence, kind))
            acks.append(await recv(connection))
        finished.set_result(acks)

    relay_server.scripts.append(script)
    await run_until(
        relay_server, finished, on_event=lambda e, c: handled.append(e["event_type"]), on_error=errors.append
    )
    assert finished.result() == [{"type": "ack", "through_sequence": str(n)} for n in (1, 2, 3)]
    assert handled == ["message.received"]
    assert len(errors) == 1 and isinstance(errors[0], RelayUnknownEventTypeError)
    assert errors[0].event_type == "future.thing"


async def test_full_sync_runs_the_handler_then_completes_and_moves_the_checkpoint(relay_server: FakeRelay) -> None:
    synced: List[Dict[str, str]] = []
    finished: asyncio.Future[Any] = asyncio.get_running_loop().create_future()

    async def script(connection: ServerConnection) -> None:
        await connection.send(ready("2", full_sync_through="9"))
        await connection.send(
            json.dumps({"type": "full_sync", "through_sequence": "9", "reason": "checkpoint_outside_retention"})
        )
        complete = await recv(connection)
        await connection.send(event(10))
        finished.set_result((complete, await recv(connection)))

    relay_server.scripts.append(script)
    await run_until(relay_server, finished, on_event=lambda e, c: None, on_full_sync=synced.append)
    assert synced == [{"through_sequence": "9", "reason": "checkpoint_outside_retention"}]
    assert finished.result() == (
        {"type": "full_sync_complete", "through_sequence": "9"},
        {"type": "ack", "through_sequence": "10"},
    )


async def test_a_gap_in_sequences_is_a_protocol_error_closed_4002(relay_server: FakeRelay) -> None:
    code: asyncio.Future[Optional[int]] = asyncio.get_running_loop().create_future()

    async def script(connection: ServerConnection) -> None:
        await connection.send(ready("0"))
        await connection.send(event(2))
        code.set_result(await closed(connection))

    relay_server.scripts.append(script)
    relay = Relay("agent-token", base_url=relay_server.base_url)
    with pytest.raises(WebSocketProtocolError, match="non-contiguous"):
        await asyncio.wait_for(relay.websocket.run(on_event=lambda e, c: None, on_full_sync=lambda c: None), 5)
    assert await asyncio.wait_for(code, 2) == 4002


async def test_a_webhook_subscription_refuses_the_upgrade_with_409(relay_server: FakeRelay) -> None:
    relay_server.refusals.append((409, json.dumps({"error": {"message": "Delete the webhook."}, "trace_id": "t1"})))
    relay = Relay("agent-token", base_url=relay_server.base_url)
    with pytest.raises(RelayWebhookConfiguredError, match="Delete the webhook.") as raised:
        await asyncio.wait_for(relay.websocket.run(on_event=lambda e, c: None, on_full_sync=lambda c: None), 5)
    assert raised.value.trace_id == "t1"


async def test_a_revoked_token_stops_with_the_close_code(relay_server: FakeRelay) -> None:
    async def script(connection: ServerConnection) -> None:
        await connection.send(ready())
        await connection.send(json.dumps({"type": "disconnect", "reason": "revoked"}))
        await connection.close(4401, "revoked")

    relay_server.scripts.append(script)
    relay = Relay("agent-token", base_url=relay_server.base_url)
    with pytest.raises(WebSocketStoppedError, match="revoked"):
        await asyncio.wait_for(relay.websocket.run(on_event=lambda e, c: None, on_full_sync=lambda c: None), 5)


async def test_reconnects_back_off_exponentially_and_ready_resets_the_backoff(
    relay_server: FakeRelay, monkeypatch: pytest.MonkeyPatch
) -> None:
    delays: List[float] = []

    async def record(delay: float) -> None:
        delays.append(delay)
        await asyncio.sleep(0)

    monkeypatch.setattr(websocket, "_sleep", record)
    relay_server.refusals += [(503, "down"), (503, "down"), (503, "down")]
    finished: asyncio.Future[Any] = asyncio.get_running_loop().create_future()

    async def restart(connection: ServerConnection) -> None:
        await connection.send(ready())
        await connection.send(json.dumps({"type": "disconnect", "reason": "restart"}))
        await connection.wait_closed()

    async def last(connection: ServerConnection) -> None:
        finished.set_result(None)
        await connection.wait_closed()

    relay_server.scripts += [restart, last]
    await run_until(
        relay_server, finished, on_event=lambda e, c: None, random=lambda: 1.0, max_reconnect_delay=1.5
    )
    # Three refused upgrades: 0.5, 1.0, then 2.0 capped at 1.5. The restart
    # after a ready starts again from the minimum.
    assert delays == [0.5, 1.0, 1.5, 0.5]


def test_the_known_event_types_are_the_typescript_sdks() -> None:
    operations = Path(__file__).parents[3] / "packages" / "sdk" / "src" / "operations.ts"
    block = operations.read_text().split("export const RELAY_WEBHOOK_EVENT_TYPES = [", 1)[1].split("]", 1)[0]
    assert RELAY_WEBHOOK_EVENT_TYPES == tuple(re.findall(r'"([^"]+)"', block))


def test_the_websocket_url_follows_the_base_url() -> None:
    assert websocket_url("https://api.staging.relayapp.im") == "wss://api.staging.relayapp.im/v1/websocket"
    assert websocket_url("http://127.0.0.1:8787/x?y=1", observe=True) == "ws://127.0.0.1:8787/v1/websocket?observe=true"
    with pytest.raises(TypeError):
        websocket_url("https://user:pw@api.relayapp.im")
