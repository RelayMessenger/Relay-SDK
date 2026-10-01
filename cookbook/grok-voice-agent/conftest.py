"""Tests never reach a paid API (xAI, ElevenLabs, LiveKit Cloud), even when a
real key is in the environment: every connection to a host that is not this
machine fails at once."""

import ipaddress
import socket

import pytest


def _local(address: object) -> bool:
    if not isinstance(address, tuple):
        return True  # a Unix socket
    host = str(address[0])
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


@pytest.fixture(autouse=True)
def no_network(monkeypatch: pytest.MonkeyPatch) -> None:
    connect = socket.socket.connect
    connect_ex = socket.socket.connect_ex

    def guarded_connect(self: socket.socket, address: object) -> None:
        if not _local(address):
            raise RuntimeError(f"tests never reach the network ({address!r})")
        connect(self, address)  # type: ignore[arg-type]

    def guarded_connect_ex(self: socket.socket, address: object) -> int:
        if not _local(address):
            raise RuntimeError(f"tests never reach the network ({address!r})")
        return connect_ex(self, address)  # type: ignore[arg-type]

    monkeypatch.setattr(socket.socket, "connect", guarded_connect)
    monkeypatch.setattr(socket.socket, "connect_ex", guarded_connect_ex)
