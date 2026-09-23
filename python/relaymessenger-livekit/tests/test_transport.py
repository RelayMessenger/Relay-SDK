"""Transport against a fake room and a fake peer: offers, restart rules and backoff, add-track, room frames."""

from __future__ import annotations

import asyncio
from typing import Any, Callable, Optional

import pytest
from livekit import rtc

from relaymessenger_livekit import transport as transport_module
from relaymessenger_livekit._engine import PeerConfig
from relaymessenger_livekit.transport import RelayCallTransport, RelayCallTransportError, restart_delay_ms
from relaymessenger_livekit.video import LocalVideoTrack, VideoSource

PERSON = {"contact_id": "u", "kind": "user", "attached": True, "track": "audio", "muted": False, "connected": True}
AGENT = {**PERSON, "contact_id": "a", "kind": "agent"}


class FakeRoom(rtc.EventEmitter[str]):
    def __init__(self) -> None:
        super().__init__()
        self.sent: list[dict[str, Any]] = []
        self.closed = False
        # What Relay's room sends after ``join`` when it cannot mint TURN (PROTOCOL.md section 6).
        self.ice_servers: Optional[list[dict[str, Any]]] = [{"urls": ["stun:stun.cloudflare.com:3478"]}]
        self.state: Optional[dict[str, Any]] = None

    def send_ice_servers(self, servers: list[dict[str, Any]]) -> None:
        """What `CallRoom` does with an ``iceServers`` frame: store it, then emit."""
        self.ice_servers = servers
        self.emit("ice_servers", {"type": "iceServers", "ice_servers": servers})

    async def connect(self) -> None:
        return None

    async def reconnect(self) -> None:
        return None

    def send(self, frame: dict[str, Any]) -> None:
        self.sent.append(frame)

    def connected(self) -> None:
        self.send({"type": "connected"})

    def user_update(self, *, muted: bool, video: Optional[bool] = None) -> None:
        frame: dict[str, Any] = {"type": "userUpdate", "muted": muted}
        if video is not None:
            frame["video"] = video
        self.send(frame)

    def end(self) -> None:
        self.send({"type": "end"})

    def close(self, *_: Any) -> None:
        self.closed = True

    def offers(self) -> list[dict[str, Any]]:
        return [f for f in self.sent if f["type"] == "offer"]


class Desc:
    def __init__(self, sdp: str, type: str) -> None:
        self.sdp, self.type = sdp, type


class FakeSender:
    def __init__(self, track: Any) -> None:
        self.track = track

    def replaceTrack(self, track: Any) -> None:
        self.track = track


class FakeTransceiver:
    def __init__(self, kind: str, mid: str, track: Any) -> None:
        self.kind, self.mid, self.direction = kind, mid, "sendonly"
        self.sender = FakeSender(track)

    def setCodecPreferences(self, codecs: list[Any]) -> None:
        self.codecs = codecs


class FakePeer(rtc.EventEmitter[str]):
    instances: list["FakePeer"] = []

    def __init__(self, config: PeerConfig) -> None:
        super().__init__()
        self.config = config
        self.transceivers: list[FakeTransceiver] = []
        self.connectionState = "new"
        self.iceConnectionState = "new"
        self.iceGatheringState = "new"
        self.signalingState = "stable"
        self.localDescription: Optional[Desc] = None
        self.remoteDescription: Optional[Desc] = None
        self.closed = False
        FakePeer.instances.append(self)

    def on(self, event: str, callback: Optional[Callable[..., Any]] = None) -> Any:  # pyee-style decorator
        if callback is None:
            return lambda cb: super(FakePeer, self).on(event, cb)
        return super().on(event, callback)

    def addTransceiver(self, track_or_kind: Any, direction: str) -> FakeTransceiver:
        kind = track_or_kind if isinstance(track_or_kind, str) else track_or_kind.kind
        t = FakeTransceiver(kind, str(len(self.transceivers)), None if isinstance(track_or_kind, str) else track_or_kind)
        self.transceivers.append(t)
        return t

    def getTransceivers(self) -> list[FakeTransceiver]:
        return self.transceivers

    async def createOffer(self) -> Desc:
        return Desc("offer", "offer")

    async def createAnswer(self) -> Desc:
        return Desc("answer", "answer")

    async def setLocalDescription(self, d: Desc) -> None:
        self.localDescription = Desc(
            f"v=0\r\na=candidate:1 1 udp 1 10.0.0.1 5000 typ host\r\n{d.type} {len(self.transceivers)}", d.type
        )
        self.signalingState = "have-local-offer" if d.type == "offer" else "stable"

    async def setRemoteDescription(self, d: Any) -> None:
        self.remoteDescription = d
        self.signalingState = "stable" if d.type == "answer" else "have-remote-offer"

    async def close(self) -> None:
        self.closed = True

    def set_state(self, state: str) -> None:
        self.connectionState = state
        self.emit("connectionstatechange")


def answer(sdp: str = "v=0\r\na=candidate:1 1 udp 1 1.2.3.4 1473 typ host\r\n") -> dict[str, Any]:
    return {"type": "answer", "session_description": {"type": "answer", "sdp": sdp}}


async def settle() -> None:
    for _ in range(20):
        await asyncio.sleep(0)


def make(**kwargs: Any) -> tuple[RelayCallTransport, FakeRoom]:
    FakePeer.instances = []
    room = FakeRoom()
    transport = RelayCallTransport(call_id="call_1", room=room, _peer_factory=FakePeer, **kwargs)  # type: ignore[arg-type]
    return transport, room


async def connected(transport: RelayCallTransport, room: FakeRoom) -> asyncio.Task[None]:
    task = asyncio.ensure_future(transport.connect())
    await settle()
    room.emit("answer", answer())
    await settle()
    FakePeer.instances[-1].set_state("connected")
    await settle()
    return task


def test_restart_rule_numbers_match_the_protocol() -> None:
    assert transport_module.RESTART_CONNECT_TIMEOUT_MS == 5_000
    assert transport_module.RESTART_DISCONNECTED_MS == 7_000
    assert [round(restart_delay_ms(n), 4) for n in (1, 2, 3, 4)] == [250, 275, 302.5, 332.75]
    assert restart_delay_ms(60) == 10_000
    assert transport_module.DEFAULT_ICE_SERVERS[0].urls == "stun:stun.cloudflare.com:3478"


async def test_connect_publishes_audio_and_reports_connected() -> None:
    transport, room = make()
    task = await connected(transport, room)
    await task
    offer = room.offers()[0]
    assert offer["tracks"] == [{"mid": "0", "name": "audio"}]
    assert "restart" not in offer
    assert {"type": "connected"} in room.sent
    # No application servers: the room's ``iceServers`` frame.
    assert FakePeer.instances[0].config.ice_servers[0].urls == ["stun:stun.cloudflare.com:3478"]
    d = transport.diagnostics()
    assert d.local["host"] == 1 and d.remote == [("udp", 1473)]
    await transport.aclose()


async def test_no_connected_within_the_session_timeout_restarts_on_a_new_peer() -> None:
    transport, room = make(session_connect_timeout_ms=30)
    restarted = []
    transport.on("restarted", restarted.append)
    task = asyncio.ensure_future(transport.connect())
    await settle()
    room.emit("answer", answer())
    await settle()
    first = FakePeer.instances[0]
    await asyncio.sleep(0.03 + 0.25 + 0.05)
    await settle()
    assert first.closed
    assert len(FakePeer.instances) == 2
    assert room.offers()[-1]["restart"] is True
    assert restarted[0].reason == "timeout" and restarted[0].delay_ms == 250 and restarted[0].restarts == 1
    # The second session also never connects: backoff grows x1.1.
    room.emit("answer", answer("v=0\r\n"))
    await asyncio.sleep(0.03 + 0.275 + 0.05)
    await settle()
    assert restarted[1].delay_ms == pytest.approx(275)
    # A session that connects ends connect() and resets the backoff.
    room.emit("answer", answer("v=0 third\r\n"))
    await settle()
    FakePeer.instances[-1].set_state("connected")
    await task
    FakePeer.instances[-1].set_state("failed")
    await asyncio.sleep(0.3)
    await settle()
    assert restarted[-1].reason == "failed" and restarted[-1].delay_ms == 250
    await transport.aclose()


async def test_disconnected_for_the_limit_restarts_and_reconnecting_in_time_does_not() -> None:
    transport, room = make(_restart_disconnected_ms=60)
    await (await connected(transport, room))
    peer = FakePeer.instances[0]
    peer.set_state("disconnected")
    await asyncio.sleep(0.03)
    peer.set_state("connected")
    await asyncio.sleep(0.06)
    assert len(FakePeer.instances) == 1
    peer.set_state("disconnected")
    await asyncio.sleep(0.06 + 0.25 + 0.05)
    await settle()
    assert len(FakePeer.instances) == 2 and transport.diagnostics().restarts == 1
    await transport.aclose()


async def test_ended_stops_restarts_and_rejects_waiters() -> None:
    transport, room = make(session_connect_timeout_ms=30)
    task = asyncio.ensure_future(transport.connect())
    await settle()
    room.emit("answer", answer())
    room.emit("ended", {"type": "ended", "reason": "completed"})
    with pytest.raises(RelayCallTransportError):
        await task
    await asyncio.sleep(0.1)
    assert len(FakePeer.instances) == 1


async def test_room_state_drives_remote_video_and_peer_audio() -> None:
    transport, room = make()
    await (await connected(transport, room))
    seen = []
    transport.on("remote_video", seen.append)
    room.emit("room_state", {"type": "roomState", "call": {"id": "c", "chat_id": "x", "status": "in-progress"},
                             "participants": [{**PERSON, "video": True, "tracks": ["audio", "video"]}, AGENT]})
    assert seen == [True]
    waiter = asyncio.ensure_future(transport.wait_for_peer_audio(1_000))
    await settle()
    assert not waiter.done()
    transport._peer_audio_arrived = True
    transport._check_peer_audio()
    await waiter
    await transport.aclose()


async def test_publish_track_sends_an_add_track_offer_then_user_update() -> None:
    transport, room = make()
    await (await connected(transport, room))
    source = VideoSource(64, 48)
    track = LocalVideoTrack.create_video_track("camera", source)
    await transport.publish_track(track)
    offer = room.offers()[-1]
    assert offer["tracks"] == [{"mid": "0", "name": "audio"}, {"mid": "1", "name": "video"}]
    assert "restart" not in offer
    assert room.sent[-1] == {"type": "userUpdate", "muted": False, "video": True}
    # A pull offer that crosses the add-track offer waits for its answer.
    room.emit("offer", {"type": "offer", "session_description": {"type": "offer", "sdp": "pull"}, "track": "video"})
    await settle()
    assert not any(f["type"] == "answer" for f in room.sent)
    room.emit("answer", answer("v=0 video\r\n"))
    await settle()
    assert room.sent[-1]["type"] == "answer"
    # Camera off keeps the track negotiated: the sender stops, nothing is re-offered.
    offers = len(room.offers())
    await transport.unpublish_track(track)
    assert FakePeer.instances[0].transceivers[1].sender.track is None
    assert room.sent[-1] == {"type": "userUpdate", "muted": False, "video": False}
    assert len(room.offers()) == offers
    await transport.aclose()


async def test_write_audio_slices_into_10_ms_and_validates() -> None:
    import numpy as np

    transport, room = make()
    await (await connected(transport, room))
    from relaymessenger_livekit.transport import RelayAudioFrame

    await transport.write_audio(RelayAudioFrame(np.zeros(24_000 * 25 // 1000, dtype=np.int16), 24_000, 1))
    assert transport.diagnostics().outbound.frames == 3  # 25 ms -> three 10 ms slices, the last padded
    assert transport.queued_audio_ms() == 30  # one 20 ms packet encoded plus the padded 10 ms slice pending
    with pytest.raises(ValueError):
        await transport.write_audio(RelayAudioFrame(np.zeros(3, dtype=np.int16), 24_000, 2))
    with pytest.raises(ValueError):
        await transport.write_audio(RelayAudioFrame(np.zeros(10, dtype=np.int16), 44_101, 1))
    await transport.aclose()


async def test_ice_servers_provider_is_called_before_every_peer() -> None:
    calls: list[int] = []

    async def provider(restarts: int) -> list[dict[str, Any]]:
        calls.append(restarts)
        return [{"urls": "turn:turn.example:3478?transport=udp", "username": f"u{restarts}", "credential": "c"}]

    transport, room = make(ice_servers=provider, session_connect_timeout_ms=30)
    task = asyncio.ensure_future(transport.connect())
    await settle()
    room.emit("answer", answer())
    await asyncio.sleep(0.03 + 0.25 + 0.05)
    await settle()
    assert calls == [0, 1]
    assert FakePeer.instances[1].config.ice_servers[0].username == "u1"
    task.cancel()
    await transport.aclose()


def test_only_public_aiortc_options_no_relay_policy_and_no_candidate_pair() -> None:
    import dataclasses
    import inspect

    from relaymessenger_livekit import RelayCallDiagnostics, RelayLiveKitCall

    # aiortc has no public iceTransportPolicy and no public selected candidate pair.
    assert "ice_transport_policy" not in inspect.signature(RelayCallTransport).parameters
    assert "ice_transport_policy" not in inspect.signature(RelayLiveKitCall.connect).parameters
    assert "selected_pair" not in {f.name for f in dataclasses.fields(RelayCallDiagnostics)}


def room_turn(username: str) -> list[dict[str, Any]]:
    """Cloudflare's live ``generate-ice-servers`` list, TCP deliberately first to prove the reorder."""
    return [
        {"urls": ["stun:stun.cloudflare.com:3478", "stun:stun.cloudflare.com:53"]},
        {
            "urls": [
                "turns:turn.cloudflare.com:443?transport=tcp",
                "turn:turn.cloudflare.com:80?transport=tcp",
                "turn:turn.cloudflare.com:53?transport=udp",
                "turn:turn.cloudflare.com:3478?transport=udp",
            ],
            "username": username,
            "credential": f"{username}-credential",
        },
    ]


def aiortc_pick(peer: FakePeer) -> dict[str, Any]:
    """What aiortc keeps from the peer's servers (aiortc/rtcicetransport.py `connection_kwargs`)."""
    from aiortc import RTCIceServer
    from aiortc.rtcicetransport import connection_kwargs

    servers = [RTCIceServer(urls=s.urls, username=s.username, credential=s.credential) for s in peer.config.ice_servers]
    return connection_kwargs(servers)


async def test_first_peer_waits_for_the_room_ice_servers_and_aiortc_picks_turn_udp_3478() -> None:
    transport, room = make()
    room.ice_servers = None
    task = asyncio.ensure_future(transport.connect())
    await settle()
    assert FakePeer.instances == []  # joined, but neither iceServers nor roomState has arrived
    room.send_ice_servers(room_turn("u0"))
    await settle()
    kwargs = aiortc_pick(FakePeer.instances[0])
    assert kwargs["stun_server"] == ("stun.cloudflare.com", 3478)
    assert kwargs["turn_server"] == ("turn.cloudflare.com", 3478)
    assert kwargs["turn_transport"] == "udp"
    assert kwargs["turn_username"] == "u0"
    assert len(room.offers()) == 1
    task.cancel()
    await transport.aclose()


async def test_a_room_state_with_no_ice_servers_before_it_means_cloudflare_stun() -> None:
    transport, room = make()
    room.ice_servers = None
    task = asyncio.ensure_future(transport.connect())
    await settle()
    assert FakePeer.instances == []
    room.state = {"type": "roomState", "call": {"id": "c", "chat_id": "c", "status": "ringing"}, "participants": [PERSON, AGENT]}
    room.emit("room_state", room.state)
    await settle()
    assert [s.urls for s in FakePeer.instances[0].config.ice_servers] == ["stun:stun.cloudflare.com:3478"]
    task.cancel()
    await transport.aclose()

    # A room that already sent its roomState and no iceServers: no wait at all.
    again, joined = make()
    joined.ice_servers = None
    joined.state = {"type": "roomState", "call": {"id": "c", "chat_id": "c", "status": "in-progress"}, "participants": [PERSON, AGENT]}
    task = asyncio.ensure_future(again.connect())
    await settle()
    assert [s.urls for s in FakePeer.instances[0].config.ice_servers] == ["stun:stun.cloudflare.com:3478"]
    task.cancel()
    await again.aclose()


async def test_closing_while_waiting_for_the_room_ice_servers_builds_no_peer() -> None:
    transport, room = make()
    room.ice_servers = None
    task = asyncio.ensure_future(transport.connect())
    await settle()
    transport.close()
    with pytest.raises(RelayCallTransportError, match="closed before media connected"):
        await task
    assert FakePeer.instances == []


async def test_restart_uses_the_room_latest_ice_servers_and_an_application_value_wins() -> None:
    transport, room = make(session_connect_timeout_ms=30)
    room.ice_servers = room_turn("u0")
    task = asyncio.ensure_future(transport.connect())
    await settle()
    room.emit("answer", answer())
    room.send_ice_servers(room_turn("u1"))  # the socket rejoined with fresh credentials
    await asyncio.sleep(0.03 + 0.25 + 0.05)
    await settle()
    assert [aiortc_pick(p)["turn_username"] for p in FakePeer.instances[:2]] == ["u0", "u1"]
    task.cancel()
    await transport.aclose()

    own, own_room = make(ice_servers=[{"urls": "stun:stun.l.google.com:19302"}])
    own_room.ice_servers = room_turn("room")
    task = asyncio.ensure_future(own.connect())
    await settle()
    assert [s.urls for s in FakePeer.instances[0].config.ice_servers] == ["stun:stun.l.google.com:19302"]
    task.cancel()
    await own.aclose()
