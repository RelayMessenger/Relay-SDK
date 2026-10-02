"""Rive messages, the viseme helper, the room's rive frames, and the channel over real aiortc."""

from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest

from relaymessenger.calls import (
    RIVE_MESSAGE_MAX_BYTES,
    VISEMES,
    WordTiming,
    alignment_from_words,
    encode_rive_message,
    parse_call_room_server_frame,
    parse_rive_message,
    visemes_from_alignment,
)
from relaymessenger.calls.room import CallRoomError


def align(text: str, ms: float = 50, start: float = 0) -> Any:
    return {
        "chars": list(text),
        "char_start_times_ms": [start + i * ms for i in range(len(text))],
        "char_durations_ms": [ms] * len(text),
    }


def named(cues: list[Any]) -> list[tuple[float, str]]:
    return [(cue.t, VISEMES[cue.viseme]) for cue in cues]


def test_encodes_the_three_agent_messages_byte_for_byte_like_typescript() -> None:
    assert encode_rive_message(t=1840.5, view_model={"viseme": 3, "speaking": True}) == (
        '{"t":1841,"view_model":{"viseme":3,"speaking":true}}'
    )
    assert encode_rive_message(t=2600, trigger="nod") == '{"t":2600,"trigger":"nod"}'
    assert json.loads(encode_rive_message(file="https://cdn.relay/rive/q.riv", artboard="Quiz", state_machine="Main")) == {
        "file": "https://cdn.relay/rive/q.riv",
        "artboard": "Quiz",
        "state_machine": "Main",
    }


def test_refuses_malformed_messages_and_anything_over_1_kb() -> None:
    for bad in (
        {},
        {"t": -1, "trigger": "nod"},
        {"trigger": ""},
        {"view_model": {}},
        {"view_model": {"x": float("nan")}},
        {"view_model": {"x": {"y": 1}}},
        {"artboard": "Quiz"},
    ):
        with pytest.raises(ValueError):
            encode_rive_message(**bad)
    fits = "x" * (RIVE_MESSAGE_MAX_BYTES - len('{"view_model":{"s":""}}'))
    assert len(encode_rive_message(view_model={"s": fits})) == RIVE_MESSAGE_MAX_BYTES
    with pytest.raises(ValueError, match="1024 bytes"):
        encode_rive_message(view_model={"s": fits + "x"})
    with pytest.raises(ValueError, match="1024 bytes"):
        encode_rive_message(view_model={"s": "é" * len(fits)})


def test_parses_phone_messages_and_drops_the_malformed() -> None:
    assert parse_rive_message('{"view_model":{"answer":"B"},"extra":1}') == {"view_model": {"answer": "B"}}
    assert parse_rive_message(b'{"trigger":"tapped_start"}') == {"trigger": "tapped_start"}
    assert parse_rive_message("[]") is None
    assert parse_rive_message('{"t":5}') is None
    assert parse_rive_message('{"trigger":3}') is None
    # A 400-digit integer overflows math.isfinite; it is refused, never raised.
    assert parse_rive_message('{"view_model":{"x":' + "9" * 400 + "}}") is None


def test_maps_letters_through_papagayos_table_like_typescript() -> None:
    assert named(visemes_from_alignment(align("map"))) == [(0, "MBP"), (50, "AI"), (100, "MBP"), (150, "rest")]
    assert named(visemes_from_alignment(align("of"))) == [(0, "O"), (50, "FV"), (100, "rest")]
    assert named(visemes_from_alignment(align("sue"))) == [(0, "etc"), (50, "U"), (100, "E"), (150, "rest")]
    assert named(visemes_from_alignment(align("shoo me."))) == [
        (0, "WQ"), (100, "U"), (250, "MBP"), (300, "E"), (350, "rest"),
    ]  # fmt: skip
    assert named(visemes_from_alignment(align("am", 40, 1_000), end_with_rest=False)) == [(1_000, "AI"), (1_040, "MBP")]


def test_spreads_word_timings_over_letters() -> None:
    alignment = alignment_from_words([WordTiming("hi", 0, 200), WordTiming("mo", 300, 400)])
    assert list(alignment["chars"]) == ["h", "i", " ", "m", "o", " "]
    assert named(visemes_from_alignment(alignment)) == [(0, "E"), (100, "AI"), (300, "MBP"), (350, "O"), (400, "rest")]


def test_room_accepts_rive_frames_and_refuses_bad_stream_ids() -> None:
    assert parse_call_room_server_frame({"type": "rive", "id": 65_534}) == {"type": "rive", "id": 65_534}
    for bad in ({"type": "rive", "id": 65_535}, {"type": "rive", "id": True}, {"type": "rive", "id": 1.5}, {"type": "rive"}):
        with pytest.raises(CallRoomError):
            parse_call_room_server_frame(bad)
    offer = {"type": "offer", "session_description": {"type": "offer", "sdp": "v=0"}, "track": "rive"}
    assert parse_call_room_server_frame(offer) == offer


async def test_negotiated_rive_channel_opens_over_aiortc_when_the_far_side_renegotiates() -> None:
    """Cloudflare's establish offer adds the application m-line after audio connected; aiortc must associate SCTP then."""
    from aiortc import RTCPeerConnection

    from relaymessenger.calls._audio import RelayAudioSource

    agent, sfu = RTCPeerConnection(), RTCPeerConnection()
    source = RelayAudioSource()
    agent.addTransceiver(source.create_track(), direction="sendonly")
    await agent.setLocalDescription(await agent.createOffer())
    await sfu.setRemoteDescription(agent.localDescription)
    await sfu.setLocalDescription(await sfu.createAnswer())
    await agent.setRemoteDescription(sfu.localDescription)
    for _ in range(100):
        if agent.connectionState == "connected" and sfu.connectionState == "connected":
            break
        await asyncio.sleep(0.05)
    assert agent.connectionState == "connected"
    options: dict[str, Any] = {"negotiated": True, "id": 3, "ordered": False, "maxRetransmits": 0}
    far = sfu.createDataChannel("rive", **options)
    await sfu.setLocalDescription(await sfu.createOffer())
    await agent.setRemoteDescription(sfu.localDescription)
    await agent.setLocalDescription(await agent.createAnswer())
    await sfu.setRemoteDescription(agent.localDescription)
    near = agent.createDataChannel("rive", **options)
    received: asyncio.Future[str] = asyncio.get_running_loop().create_future()
    far.on("message", lambda data: received.done() or received.set_result(data))
    for _ in range(100):
        if near.readyState == "open" and far.readyState == "open":
            break
        await asyncio.sleep(0.05)
    assert (near.readyState, far.readyState) == ("open", "open")
    near.send('{"t":20,"view_model":{"viseme":3}}')
    assert json.loads(await asyncio.wait_for(received, 5)) == {"t": 20, "view_model": {"viseme": 3}}
    await agent.close()
    await sfu.close()


async def test_the_rive_clock_is_the_wire_rtp_timestamp_over_aiortc() -> None:
    """aiortc adds a random origin to every RTP timestamp; `rtp_origin` reads it back so `t` matches the wire."""
    from aiortc import RTCPeerConnection
    from aiortc.rtp import RtpPacket

    from relaymessenger.calls._audio import RelayAudioSource, rtp_origin

    agent, far = RTCPeerConnection(), RTCPeerConnection()
    source = RelayAudioSource()
    track = source.create_track()
    sender = agent.addTransceiver(track, direction="sendonly").sender
    wire: list[tuple[int, int]] = []  # (wire timestamp, source pts of the packet the track handed out)
    send_rtp = sender.transport._send_rtp

    async def record(data: bytes) -> None:
        wire.append((RtpPacket.parse(data).timestamp, track.last_pts))
        await send_rtp(data)

    sender.transport._send_rtp = record
    await agent.setLocalDescription(await agent.createOffer())
    await far.setRemoteDescription(agent.localDescription)
    await far.setLocalDescription(await far.createAnswer())
    await agent.setRemoteDescription(far.localDescription)
    origin = None
    for _ in range(400):
        origin = rtp_origin(sender)
        if origin is not None and len(wire) >= 3:
            break
        await asyncio.sleep(0.01)
    assert origin is not None and wire
    # The serialized packets carry origin + the source's timestamp, mod 2^32.
    assert all(timestamp == (origin + pts) & 0xFFFFFFFF for timestamp, pts in wire)
    sender.transport._send_rtp = send_rtp
    source.stop()  # the sender's pull ends, as the transport's teardown does
    await asyncio.wait_for(far.close(), 10)
    await asyncio.wait_for(agent.close(), 10)
