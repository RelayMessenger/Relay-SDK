"""The offer waits a bounded time for TURN, and a TURN allocation that answers later still carries ICE checks."""

from __future__ import annotations

import asyncio
import socket
import time
from types import SimpleNamespace
from typing import Any

import pytest
from aioice import Candidate, Connection
from aioice import ice as aioice_ice

from relaymessenger.calls import _engine
from relaymessenger.calls._engine import PeerConfig, RelayIceServer, bound_relay_gathering, create_peer_connection


@pytest.fixture
def silent_udp_port() -> Any:
    """A bound UDP socket that never answers: a TURN server the container cannot reach."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind(("127.0.0.1", 0))
    yield sock.getsockname()[1]
    sock.close()


async def test_an_unanswered_turn_server_delays_the_offer_by_the_bound_not_5_s(
    silent_udp_port: int, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(_engine, "RELAY_GATHERING_BOUND_S", 0.2)
    server = RelayIceServer(urls=f"turn:127.0.0.1:{silent_udp_port}?transport=udp", username="u", credential="c")
    peer = create_peer_connection(PeerConfig(ice_servers=[server]))
    peer.addTransceiver("audio", direction="sendonly")
    started = time.monotonic()
    await peer.setLocalDescription(await peer.createOffer())
    elapsed = time.monotonic() - started
    assert elapsed < 1.5, f"offer took {elapsed:.2f} s; aioice alone waits 5 s"
    assert "typ host" in peer.localDescription.sdp
    assert "typ relay" not in peer.localDescription.sdp
    await peer.close()


class LateRelay:
    """Stands in for a TURN allocation's protocol: records the ICE checks sent through it."""

    def __init__(self) -> None:
        self.local_candidate = Candidate(
            foundation="relay1", component=1, transport="udp", priority=1,
            host="127.0.0.1", port=40000, type="relay",
        )
        self.checks: list[tuple[str, int]] = []

    async def request(self, request: Any, addr: tuple[str, int], integrity_key: Any = None, retransmissions: Any = None) -> Any:
        self.checks.append(addr)
        await asyncio.sleep(30)

    async def close(self) -> None:
        pass


async def test_a_turn_allocation_after_the_bound_sends_checks_while_ice_is_checking(
    silent_udp_port: int, monkeypatch: pytest.MonkeyPatch
) -> None:
    relay = LateRelay()

    async def slow_allocation(**_: Any) -> tuple[Candidate, LateRelay]:
        await asyncio.sleep(0.4)
        return relay.local_candidate, relay

    monkeypatch.setattr(aioice_ice, "relayed_candidate", slow_allocation)
    connection = Connection(ice_controlling=True, turn_server=("192.0.2.1", 3478), turn_username="u", turn_password="c")
    bound_relay_gathering(SimpleNamespace(state="new", _connection=connection), bound_s=0.05)

    started = time.monotonic()
    await connection.gather_candidates()
    assert time.monotonic() - started < 0.3
    assert [c.type for c in connection.local_candidates if c.type == "relay"] == []

    # The SFU's one candidate, which no host socket can reach.
    connection.remote_username, connection.remote_password = "sfu", "sfu-password"
    await connection.add_remote_candidate(
        Candidate(foundation="sfu", component=1, transport="udp", priority=1, host="127.0.0.1", port=silent_udp_port, type="host")
    )
    await connection.add_remote_candidate(None)
    checking = asyncio.ensure_future(connection.connect())
    await asyncio.sleep(1.0)
    assert relay.checks == [("127.0.0.1", silent_udp_port)]
    checking.cancel()
    await connection.close()
