"""Transport against a fake room and a fake peer: offers, restart rules and backoff, add-track, room frames."""

from __future__ import annotations

import asyncio
from typing import Any, Callable, Optional

import pytest

from relaymessenger.calls import EventEmitter
from relaymessenger.calls import transport as transport_module
from relaymessenger.calls._engine import PeerConfig
from relaymessenger.calls.transport import RelayCallTransport, RelayCallTransportError, restart_delay_ms
from relaymessenger.calls import video as video_module
from relaymessenger.calls.video import LocalVideoTrack, VideoSource

PERSON = {"contact_id": "u", "kind": "user", "attached": True, "track": "audio", "muted": False, "connected": True}
AGENT = {**PERSON, "contact_id": "a", "kind": "agent"}


class FakeRoom(EventEmitter[str]):
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
        self.keyframes_forced = 0

    def _send_keyframe(self) -> None:  # aiortc's RTCRtpSender: the next encoded frame is a keyframe
        self.keyframes_forced += 1

    def replaceTrack(self, track: Any) -> None:
        self.track = track


class FakeTransceiver:
    def __init__(self, kind: str, mid: str, track: Any) -> None:
        self.kind, self.mid, self.direction = kind, mid, "sendonly"
        self.sender = FakeSender(track)

    def setCodecPreferences(self, codecs: list[Any]) -> None:
        self.codecs = codecs


class FakeDataChannel(EventEmitter[str]):
    """aiortc's RTCDataChannel surface: pyee events, ``readyState``, ``send``, ``close``."""

    def __init__(self, label: str, options: dict[str, Any]) -> None:
        super().__init__()
        self.label = label
        self.options = options
        self.readyState = "connecting"
        self.sent: list[str] = []

    def on(self, event: str, callback: Optional[Callable[..., Any]] = None) -> Any:
        if callback is None:
            return lambda cb: super(FakeDataChannel, self).on(event, cb)
        return super().on(event, callback)

    def remove_all_listeners(self) -> None:
        self._events.clear()

    def send(self, data: str) -> None:
        if self.readyState != "open":
            raise RuntimeError("not open")
        self.sent.append(data)

    def close(self) -> None:
        self.readyState = "closed"

    def open(self) -> None:
        self.readyState = "open"
        self.emit("open")


class FakePeer(EventEmitter[str]):
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
        self.channels: list[FakeDataChannel] = []
        FakePeer.instances.append(self)

    def createDataChannel(self, label: str, **options: Any) -> FakeDataChannel:
        channel = FakeDataChannel(label, options)
        self.channels.append(channel)
        return channel

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


async def test_publish_track_before_connect_sends_audio_and_video_in_the_first_offer() -> None:
    # Cloudflare's echo example pushes audio and video with one tracks/new; an
    # add-track offer right after join crossed the room's pull and got HTTP 406.
    transport, room = make()
    track = LocalVideoTrack.create_video_track("camera", VideoSource(64, 48))
    await transport.publish_track(track)
    assert room.sent == []
    await (await connected(transport, room))
    offers = room.offers()
    assert len(offers) == 1
    assert offers[0]["tracks"] == [{"mid": "0", "name": "audio"}, {"mid": "1", "name": "video"}]
    assert room.sent.index({"type": "userUpdate", "muted": False, "video": True}) < room.sent.index(offers[0])
    assert FakePeer.instances[0].transceivers[1].sender.track is not None
    await transport.aclose()


#: Cloudflare's answer to an audio + video offer (staging, 2026-09-23), address
#: moved to TEST-NET: candidates only in the BUNDLE-tagged section (RFC 9143 7.1.3).
CLOUDFLARE_AUDIO_VIDEO_ANSWER = "\r\n".join([
    "v=0", "o=- 5156661386025904969 1790184677 IN IP4 0.0.0.0", "s=-", "t=0 0", "a=msid-semantic:WMS*",
    "a=fingerprint:sha-256 8A:77:80:9B:AC:80:96:9C:FF:EF:7C:1B:1F:B5:4A:5A:8F:37:FF:B7:F1:EE:D7:86:B0:DE:25:5A:E8:E6:80:59",
    "a=ice-lite", "a=group:BUNDLE 0 1",
    "m=audio 9 UDP/TLS/RTP/SAVPF 96 0 8", "c=IN IP4 0.0.0.0", "a=setup:passive", "a=mid:0",
    "a=ice-ufrag:2777758f", "a=ice-pwd:0123456789abcdef012345", "a=rtcp-mux", "a=rtcp-rsize",
    "a=rtpmap:96 opus/48000/2", "a=rtpmap:0 PCMU/8000", "a=rtpmap:8 PCMA/8000", "a=recvonly",
    "a=candidate:513273236 1 udp 2130706431 192.0.2.1 1473 typ host",
    "a=candidate:513273236 2 udp 2130706431 192.0.2.1 1473 typ host", "a=end-of-candidates",
    "m=video 9 UDP/TLS/RTP/SAVPF 101 102", "c=IN IP4 0.0.0.0", "a=setup:passive", "a=mid:1",
    "a=ice-ufrag:2777758f", "a=ice-pwd:0123456789abcdef012345", "a=rtcp-mux", "a=rtcp-rsize",
    "a=rtpmap:101 H264/90000", "a=fmtp:101 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
    "a=rtcp-fb:101 nack", "a=rtcp-fb:101 nack pli", "a=rtpmap:102 rtx/90000", "a=fmtp:102 apt=101", "a=recvonly", "",
])


async def test_an_audio_video_answer_gives_the_real_peer_its_candidates() -> None:
    # aiortc hands the shared transport the LAST bundled section's candidates
    # (aiortc issue 1437); Cloudflare puts them only in the first, so without
    # addIceCandidate the peer never sends a connectivity check.
    from relaymessenger.calls._engine import create_peer_connection

    room = FakeRoom()
    room.ice_servers = []
    peers: list[Any] = []

    def factory(config: PeerConfig) -> Any:
        peers.append(create_peer_connection(config))
        return peers[-1]

    transport = RelayCallTransport(call_id="call_1", room=room, _peer_factory=factory)  # type: ignore[arg-type]
    await transport.publish_track(LocalVideoTrack.create_video_track("camera", VideoSource(64, 48)))
    task = asyncio.ensure_future(transport.connect())
    for _ in range(100):
        if room.offers():
            break
        await asyncio.sleep(0.01)
    assert room.offers()[0]["tracks"] == [{"mid": "0", "name": "audio"}, {"mid": "1", "name": "video"}]
    room.emit("answer", answer(CLOUDFLARE_AUDIO_VIDEO_ANSWER))
    for _ in range(100):
        await asyncio.sleep(0.01)
        ice = peers[0].getTransceivers()[0].receiver.transport.transport
        if ice.getRemoteCandidates():
            break
    assert [(c.ip, c.port, c.component) for c in ice.getRemoteCandidates()][:1] == [("192.0.2.1", 1473, 1)]
    task.cancel()
    await transport.aclose()


def cloudflare_sdp(sections: list[list[str]]) -> str:
    """A Cloudflare session description (`CLOUDFLARE_AUDIO_VIDEO_ANSWER`'s session lines) with these audio sections."""
    mids = " ".join(str(n) for n in range(len(sections)))
    lines = [
        "v=0", "o=- 5156661386025904969 1790184677 IN IP4 0.0.0.0", "s=-", "t=0 0", "a=msid-semantic:WMS*",
        "a=fingerprint:sha-256 8A:77:80:9B:AC:80:96:9C:FF:EF:7C:1B:1F:B5:4A:5A:8F:37:FF:B7:F1:EE:D7:86:B0:DE:25:5A:E8:E6:80:59",
        "a=ice-lite", f"a=group:BUNDLE {mids}",
    ]
    for mid, extra in enumerate(sections):
        lines += [
            "m=audio 9 UDP/TLS/RTP/SAVPF 96", "c=IN IP4 0.0.0.0", f"a=mid:{mid}",
            "a=ice-ufrag:2777758f", "a=ice-pwd:0123456789abcdef012345", "a=rtcp-mux", "a=rtcp-rsize",
            "a=rtpmap:96 opus/48000/2", *extra,
        ]
    return "\r\n".join([*lines, ""])


async def test_an_empty_audio_frame_does_not_stop_the_persons_audio() -> None:
    # Cloudflare's SFU sends RTP packets with no payload (aiortc issue 1349);
    # aiortc queues each as an empty frame for its Opus decoder, and libavcodec
    # reads an empty packet as end of stream, so without the guard the decoder
    # thread dies on the next real packet and the agent hears nothing more.
    import fractions

    import av
    from aiortc.codecs.opus import OpusEncoder
    from aiortc.jitterbuffer import JitterFrame
    from aiortc.rtcrtpparameters import RTCRtpCodecParameters, RTCRtpReceiveParameters

    from relaymessenger.calls._engine import create_peer_connection

    room = FakeRoom()
    room.ice_servers = []
    peers: list[Any] = []

    def factory(config: PeerConfig) -> Any:
        peers.append(create_peer_connection(config))
        return peers[-1]

    transport = RelayCallTransport(call_id="call_1", room=room, _peer_factory=factory)  # type: ignore[arg-type]
    heard: list[Any] = []
    transport.on("audio", lambda frame: heard.append(frame.samples))
    task = asyncio.ensure_future(transport.connect())
    for _ in range(100):
        if room.offers():
            break
        await asyncio.sleep(0.01)
    candidates = ["a=candidate:513273236 1 udp 2130706431 192.0.2.1 1473 typ host", "a=end-of-candidates"]
    room.emit("answer", answer(cloudflare_sdp([["a=setup:passive", "a=recvonly", *candidates]])))
    await settle()
    # The room pulls the person's audio: the SFU re-offers with a second, sending section.
    pull = cloudflare_sdp([
        ["a=setup:actpass", "a=recvonly", *candidates],
        ["a=setup:actpass", "a=ssrc:1234 cname:person", "a=sendonly"],
    ])
    room.emit("offer", {"type": "offer", "session_description": {"type": "offer", "sdp": pull}, "track": "audio"})
    for _ in range(100):
        await asyncio.sleep(0.01)
        if any(f["type"] == "answer" for f in room.sent):
            break
    receiver = next(t.receiver for t in peers[0].getTransceivers() if t.direction == "recvonly")
    # What aiortc runs once DTLS connects (rtcpeerconnection.py ``__connect``): the decoder thread starts.
    opus = RTCRtpCodecParameters(mimeType="audio/opus", clockRate=48_000, channels=2, payloadType=96)
    await receiver.receive(RTCRtpReceiveParameters(codecs=[opus]))

    silence = av.AudioFrame(format="s16", layout="stereo", samples=960)
    silence.sample_rate, silence.pts, silence.time_base = 48_000, 0, fractions.Fraction(1, 48_000)
    for plane in silence.planes:
        plane.update(bytes(plane.buffer_size))
    packet = OpusEncoder().encode(silence)[0][0]
    decoder_queue = receiver._RTCRtpReceiver__decoder_queue
    for timestamp, data in ((0, packet), (960, b""), (1920, packet)):
        decoder_queue.put((opus, JitterFrame(data=data, timestamp=timestamp)))
    for _ in range(200):
        if len(heard) >= 2:
            break
        await asyncio.sleep(0.01)
    # Both real packets reach the application: 20 ms each, before and after the empty one.
    assert sum(len(samples) for samples in heard) == 2 * 960 * 2
    task.cancel()
    await transport.aclose()


async def test_write_audio_slices_into_10_ms_and_validates() -> None:
    import numpy as np

    transport, room = make()
    await (await connected(transport, room))
    from relaymessenger.calls.transport import RelayAudioFrame

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

    from relaymessenger.calls import RelayCallDiagnostics

    # aiortc has no public iceTransportPolicy and no public selected candidate pair.
    assert "ice_transport_policy" not in inspect.signature(RelayCallTransport).parameters
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


async def until(condition: Callable[[], bool], timeout_s: float = 5.0) -> None:
    """Wait on real timers for ``condition``, so a loaded machine cannot race the assertion."""
    deadline = asyncio.get_running_loop().time() + timeout_s
    while not condition():
        assert asyncio.get_running_loop().time() < deadline, "condition not met in time"
        await asyncio.sleep(0.005)


def receiving_state(receiving: list[str]) -> dict[str, Any]:
    person = {**PERSON, "video": False, "tracks": ["audio"], "receiving": receiving}
    return {"type": "roomState", "call": {"id": "c", "chat_id": "c", "status": "in-progress"}, "participants": [person, AGENT]}


async def test_subscribed_needs_receiving_audio_after_this_peers_answer_and_a_restart_resets_it() -> None:
    transport, room = make(session_connect_timeout_ms=30)
    task = asyncio.ensure_future(transport.connect())
    await settle()
    # Before the publish answer, a receiving audio entry does not count.
    room.emit("room_state", receiving_state(["audio"]))
    assert transport.subscribed is False
    room.emit("answer", answer())
    await settle()
    assert transport.subscribed is False
    room.emit("room_state", receiving_state(["audio"]))
    await settle()
    assert transport.subscribed is True
    room.emit("room_state", receiving_state([]))
    assert transport.subscribed is False
    room.emit("room_state", receiving_state(["audio"]))
    assert transport.subscribed is True
    # The session never connects (30 ms): the restart resets it until the new session is pulled.
    await until(lambda: len(FakePeer.instances) == 2)
    assert transport.subscribed is False
    await settle()
    room.emit("answer", answer("v=0 second\r\n"))
    await settle()
    assert transport.subscribed is False
    room.emit("room_state", receiving_state(["audio"]))
    assert transport.subscribed is True
    task.cancel()
    await transport.aclose()


async def test_the_camera_encodes_with_relay_h264_encoder_and_the_publish_encoding() -> None:
    transport, room = make(session_connect_timeout_ms=30)
    encoding = video_module.VideoEncoding(max_bitrate=1_000_000)
    track = LocalVideoTrack.create_video_track("camera", VideoSource(64, 48))
    await transport.publish_track(track, video_module.TrackPublishOptions(video_encoding=encoding))
    task = asyncio.ensure_future(transport.connect())
    await settle()
    # LiveKit's preset per frame size, or the caller's encoding (`use_relay_encoder`).
    encoder = FakePeer.instances[-1].transceivers[1].sender._RTCRtpSender__encoder
    assert isinstance(encoder, video_module.RelayH264Encoder) and encoder.encoding is encoding
    task.cancel()
    await transport.aclose()


async def test_the_camera_sends_a_keyframe_when_the_person_starts_receiving_it() -> None:
    # 250 ms, not 30: the first session must outlive the synchronous checks
    # below on a loaded machine, or its restart swaps the sender under them.
    transport, room = make(session_connect_timeout_ms=250)
    await transport.publish_track(LocalVideoTrack.create_video_track("camera", VideoSource(64, 48)))
    task = asyncio.ensure_future(transport.connect())
    await settle()
    video_sender = lambda: FakePeer.instances[-1].transceivers[1].sender  # noqa: E731
    room.emit("room_state", receiving_state(["audio", "video"]))  # before the publish answer: not this session
    room.emit("answer", answer())
    await settle()
    assert video_sender().keyframes_forced == 0
    # The SFU's PLI and FIR reach the camera too (`serve_keyframe_requests`).
    assert isinstance(video_sender()._send_keyframe, video_module._KeyframeRequests)
    room.emit("room_state", receiving_state(["audio"]))
    assert video_sender().keyframes_forced == 0
    room.emit("room_state", receiving_state(["audio", "video"]))
    room.emit("room_state", receiving_state(["audio", "video"]))
    assert video_sender().keyframes_forced == 1  # once, when the person starts receiving it
    # The session never connects (30 ms): the new session's pull asks again.
    await until(lambda: len(FakePeer.instances) == 2)
    await settle()
    room.emit("answer", answer("v=0 second\r\n"))
    await settle()
    room.emit("room_state", receiving_state(["audio", "video"]))
    assert video_sender().keyframes_forced == 1
    task.cancel()
    await transport.aclose()


def tagged(value: int) -> Any:
    """20 ms of 48 kHz mono PCM, one Opus packet, every sample ``value``."""
    import numpy as np

    from relaymessenger.calls import RelayAudioFrame

    return RelayAudioFrame(np.full(960, value, dtype=np.int16), 48_000, 1)


async def pull(peer: FakePeer, n: int) -> list[bytes]:
    """What the peer's audio sender would put on the wire next: ``n`` paced packets."""
    track = peer.transceivers[0].sender.track
    return [bytes(await track.recv()) for _ in range(n)]


async def test_audio_is_held_until_the_person_receives_it_then_plays_from_the_start() -> None:
    transport, room = make()
    await (await connected(transport, room))
    source = transport._source
    assert source is not None
    silence = source._silence
    for value in (1000, 2000, 3000):
        await transport.write_audio(tagged(value))
    queued = list(source._packets)
    assert len(queued) == 3
    # Not receiving yet: silence goes out and nothing queued is dropped.
    assert await pull(FakePeer.instances[0], 4) == [silence] * 4
    assert transport.queued_audio_ms() == 60
    assert transport.diagnostics().outbound.held is True
    assert transport.diagnostics().outbound.rtp_packets == 0
    room.emit("room_state", receiving_state(["audio"]))
    # Receiving: the queue plays from its first packet, in order, then silence again.
    assert await pull(FakePeer.instances[0], 4) == [*queued, silence]
    out = transport.diagnostics().outbound
    assert out.held is False and out.rtp_packets == 3 and out.first_audio_at_ms is not None
    await transport.aclose()


async def test_clearing_held_audio_drops_it_and_a_restart_holds_audio_again() -> None:
    transport, room = make()
    await (await connected(transport, room))
    source = transport._source
    assert source is not None
    silence = source._silence
    await transport.write_audio(tagged(1000))
    transport.clear_audio()  # the speech was interrupted before the person could hear it
    room.emit("room_state", receiving_state(["audio"]))
    assert await pull(FakePeer.instances[0], 2) == [silence] * 2
    # The session fails: the person's pull of it is gone, so audio is held until the new one is pulled.
    FakePeer.instances[0].set_state("failed")
    await until(lambda: len(FakePeer.instances) == 2)
    await transport.write_audio(tagged(2000))
    await transport.write_audio(tagged(3000))
    queued = list(source._packets)
    assert await pull(FakePeer.instances[1], 3) == [silence] * 3
    await settle()
    room.emit("answer", answer("v=0 second\r\n"))
    await settle()
    assert await pull(FakePeer.instances[1], 2) == [silence] * 2
    room.emit("room_state", receiving_state(["audio"]))
    assert await pull(FakePeer.instances[1], 3) == [*queued, silence]
    await transport.aclose()


def rive_requests(room: FakeRoom) -> int:
    return sum(1 for frame in room.sent if frame.get("type") == "rive")


async def test_rive_opens_the_negotiated_channel_and_carries_both_directions() -> None:
    import json

    transport, room = make()
    await (await connected(transport, room))
    opening = asyncio.ensure_future(transport.rive())
    await settle()
    assert rive_requests(room) == 1
    room.emit("offer", {"type": "offer", "session_description": {"type": "offer", "sdp": "v=0 establish"}, "track": "rive"})
    room.emit("rive", {"type": "rive", "id": 3})
    await settle()
    assert room.sent[-1]["type"] == "answer"
    peer = FakePeer.instances[0]
    channel = peer.channels[0]
    assert channel.label == "rive"
    assert channel.options == {"negotiated": True, "id": 3, "ordered": False, "maxRetransmits": 0}
    channel.open()
    rive = await opening
    assert await transport.rive() is rive and rive_requests(room) == 1
    assert rive.set({"viseme": 3, "speaking": True}, at=1840.5)
    assert rive.trigger("nod", at=2600)
    assert rive.show("https://cdn.relay/rive/q.riv", artboard="Quiz", view_model={"question": "Capital of France?"})
    assert [json.loads(text) for text in channel.sent] == [
        {"t": 1841, "view_model": {"viseme": 3, "speaking": True}},
        {"t": 2600, "trigger": "nod"},
        {"file": "https://cdn.relay/rive/q.riv", "artboard": "Quiz", "view_model": {"question": "Capital of France?"}},
    ]
    values: list[Any] = []
    triggers: list[str] = []
    rive.on("view_model", values.append)
    rive.on("trigger", triggers.append)
    channel.emit("message", json.dumps({"view_model": {"answer": "B"}}))
    channel.emit("message", json.dumps({"trigger": "tapped_start", "extra": 1}).encode())
    channel.emit("message", "not json")
    assert values == [{"answer": "B"}] and triggers == ["tapped_start"]
    await transport.aclose()
    assert channel.readyState == "closed"


async def test_rive_is_asked_for_again_after_a_restart_and_replays_state() -> None:
    import json

    transport, room = make()
    await (await connected(transport, room))
    opening = asyncio.ensure_future(transport.rive())
    await settle()
    room.emit("rive", {"type": "rive", "id": 1})
    await settle()
    first = FakePeer.instances[0]
    first.channels[0].open()
    rive = await opening
    rive.show("https://cdn.relay/rive/a.riv", state_machine="Main")
    rive.set({"mood": "happy", "viseme": 2})
    first.set_state("failed")
    await settle()
    assert first.channels[0].readyState == "closed"
    assert rive.set({"viseme": 0}) is False
    await asyncio.sleep(0.3)
    await settle()
    room.emit("answer", answer("v=0 second\r\n"))
    await settle()
    FakePeer.instances[-1].set_state("connected")
    await settle()
    assert rive_requests(room) == 2
    room.emit("rive", {"type": "rive", "id": 7})
    await settle()
    second = FakePeer.instances[-1].channels[0]
    second.open()
    assert second.options["id"] == 7
    assert [json.loads(text) for text in second.sent] == [
        {"file": "https://cdn.relay/rive/a.riv", "state_machine": "Main"},
        {"view_model": {"mood": "happy", "viseme": 0}},
    ]
    await transport.aclose()


async def test_rive_times_out_when_the_room_opens_no_channel_and_asks_again() -> None:
    transport, room = make()
    await (await connected(transport, room))
    with pytest.raises(RelayCallTransportError) as raised:
        await transport.rive(timeout_ms=20)
    assert raised.value.code == "rive_timeout"
    with pytest.raises(RelayCallTransportError):
        await transport.rive(timeout_ms=20)
    assert rive_requests(room) == 2
    await transport.aclose()


async def test_audio_time_is_rtp_time_sent_plus_queued() -> None:
    import numpy as np

    from relaymessenger.calls.transport import RelayAudioFrame

    transport, room = make()
    await (await connected(transport, room))
    source = transport._source
    assert source is not None
    source._pts = 960 * 617  # 617 packets of 20 ms sent
    assert transport.audio_time_ms() == pytest.approx(12_340)
    await transport.write_audio(RelayAudioFrame(samples=np.zeros(4_800, dtype=np.int16), sample_rate=48_000, channel_count=1))
    assert transport.audio_time_ms() == pytest.approx(12_440)
    await transport.aclose()


async def test_rive_is_rejected_at_once_when_the_room_refuses_the_channel() -> None:
    transport, room = make()
    await (await connected(transport, room))
    opening = asyncio.ensure_future(transport.rive())
    await settle()
    room.emit("error", {"type": "error", "code": "media_unavailable", "message": "The rive channel is unavailable."})
    with pytest.raises(RelayCallTransportError) as raised:
        await asyncio.wait_for(opening, 1)
    assert raised.value.code == "media_unavailable"
    assert not FakePeer.instances[0].closed
    await transport.aclose()


async def test_write_audio_returns_the_frames_track_start_once_the_person_receives_it() -> None:
    import numpy as np

    from relaymessenger.calls.transport import RelayAudioFrame

    transport, room = make()
    await (await connected(transport, room))
    source = transport._source
    assert source is not None
    source._pts = 960 * 100  # 2 s of RTP sent
    frame = RelayAudioFrame(samples=np.zeros(960, dtype=np.int16), sample_rate=48_000, channel_count=1)
    # Held: the start is known only when the person starts receiving.
    assert await transport.write_audio(frame) is None
    room.emit("room_state", receiving_state(["audio"]))
    assert transport.subscribed
    # 20 ms already queued ahead of it.
    assert await transport.write_audio(frame) == pytest.approx(2_020)
    await transport.aclose()


async def test_rive_keeps_the_open_channel_when_relay_repeats_its_id() -> None:
    transport, room = make()
    await (await connected(transport, room))
    opening = asyncio.ensure_future(transport.rive())
    await settle()
    room.emit("rive", {"type": "rive", "id": 2})
    await settle()
    peer = FakePeer.instances[0]
    peer.channels[0].open()
    await opening
    room.emit("rive", {"type": "rive", "id": 2})
    await settle()
    assert len(peer.channels) == 1 and peer.channels[0].readyState == "open"
    await transport.aclose()
