"""The framework-neutral pieces the adapters share: the event emitter and video frames."""

from __future__ import annotations

import asyncio
import fractions
import sys
import time
from typing import Any

import av
import numpy as np
import pytest

from relaymessenger.calls import (
    EventEmitter,
    LocalVideoTrack,
    RelayCallTransport,
    RelayVideoFrame,
    RemoteVideoTrack,
    VideoFrameEvent,
    VideoSource,
    VideoStream,
)
from relaymessenger.calls._engine import PeerConfig, RelayIceServer, create_peer_connection, media_ssrc, turn_only
from relaymessenger.calls import video
from relaymessenger.calls.video import TrackPublishOptions, _VideoSender, request_keyframes


def test_the_core_imports_no_livekit() -> None:
    assert not [name for name in sys.modules if name == "livekit" or name.startswith("livekit.")]


def test_relaymessenger_imports_without_the_calls_extra_and_calls_names_the_extra() -> None:
    import subprocess

    # A Python where aiortc, av and numpy are not installed.
    script = """
import importlib.abc, sys
class Missing(importlib.abc.MetaPathFinder):
    def find_spec(self, name, path=None, target=None):
        if name.split(".")[0] in ("aiortc", "av", "numpy"):
            raise ModuleNotFoundError(f"No module named {name!r}")
sys.meta_path.insert(0, Missing())
import relaymessenger
try:
    import relaymessenger.calls
except ImportError as e:
    print(e)
"""
    out = subprocess.run([sys.executable, "-c", script], capture_output=True, text=True, check=True).stdout
    assert "pip install 'relaymessenger[calls]'" in out


def test_emitter_trims_arguments_decorates_runs_once_and_removes() -> None:
    emitter: EventEmitter[str] = EventEmitter()
    seen: list[Any] = []

    @emitter.on("frame")
    def none() -> None:
        seen.append("none")

    def one(a: int) -> None:
        seen.append(("one", a))

    emitter.on("frame", one)
    emitter.once("frame", lambda *args: seen.append(("once", args)))
    emitter.emit("frame", 1, 2)
    emitter.emit("frame", 3, 4)
    emitter.off("frame", one)
    emitter.emit("frame", 5)
    assert seen == ["none", ("one", 1), ("once", (1, 2)), "none", ("one", 3), "none"]


def test_emitter_refuses_async_callbacks_and_logs_other_errors(caplog: pytest.LogCaptureFixture) -> None:
    emitter: EventEmitter[str] = EventEmitter()

    async def handler() -> None:
        pass

    with pytest.raises(ValueError):
        emitter.on("x", handler)

    def broken() -> None:
        raise RuntimeError("boom")

    after: list[int] = []
    emitter.on("x", broken)
    emitter.on("x", lambda: after.append(1))
    emitter.emit("x")
    assert after == [1]
    assert "failed to emit event x" in caplog.text


def gradient(width: int, height: int) -> np.ndarray:
    rgb = np.zeros((height, width, 3), dtype=np.uint8)
    rgb[..., 0] = np.linspace(0, 255, width, dtype=np.uint8)[None, :]
    rgb[..., 1] = 128
    rgb[..., 2] = np.linspace(255, 0, height, dtype=np.uint8)[:, None]
    return rgb


@pytest.mark.parametrize("size", [(64, 48), (63, 47)])
def test_frames_round_trip_between_rgb_i420_and_pyav(size: tuple[int, int]) -> None:
    width, height = size
    rgb = gradient(width, height)
    frame = RelayVideoFrame(width, height, "rgb24", rgb.tobytes())
    i420 = frame.convert("i420")
    chroma = ((width + 1) // 2) * ((height + 1) // 2)
    assert (i420.width, i420.height, len(i420.data)) == (width, height, width * height + 2 * chroma)
    back = np.frombuffer(i420.convert("rgb24").data, dtype=np.uint8).reshape(height, width, 3)
    # Chroma subsampling blurs colour edges; the picture itself survives.
    assert np.abs(back.astype(int) - rgb.astype(int)).mean() < 6
    assert i420.to_av().format.name == "yuv420p"


def test_frames_refuse_short_buffers() -> None:
    with pytest.raises(ValueError):
        RelayVideoFrame(64, 48, "rgba", b"\0" * (64 * 48 * 4 - 1))


async def test_a_published_source_encodes_relay_frames_and_pyav_frames() -> None:
    source = VideoSource(64, 48)
    sender = _VideoSender(LocalVideoTrack.create_video_track("camera", source), TrackPublishOptions())
    track = sender.create_track()
    source.capture_frame(RelayVideoFrame(64, 48, "rgb24", gradient(64, 48).tobytes()), timestamp_us=1_000_000)
    first = await asyncio.wait_for(track.recv(), 1)
    assert (first.width, first.height, first.pts) == (64, 48, 90_000)
    source.capture_frame(av.VideoFrame.from_ndarray(gradient(64, 48), format="rgb24"), timestamp_us=2_000_000)
    second = await asyncio.wait_for(track.recv(), 1)
    assert second.pts == 180_000
    assert sender.stats().frames_captured == 2 and sender.stats().frames_sent == 2


async def test_a_published_camera_sends_black_frames_until_its_first_frame(monkeypatch: pytest.MonkeyPatch) -> None:
    # Cloudflare's SFU refuses to forward a track that has sent no packets (empty_track_error).
    monkeypatch.setattr(video, "IDLE_FRAME_INTERVAL_S", 0.05)
    source = VideoSource(64, 48)
    sender = _VideoSender(LocalVideoTrack.create_video_track("camera", source), TrackPublishOptions())
    track = sender.create_track()
    started = time.monotonic()
    idle = [await asyncio.wait_for(track.recv(), 1) for _ in range(3)]
    assert time.monotonic() - started >= 0.09  # one a period, the first at once
    for frame in idle:
        assert (frame.width, frame.height) == (64, 48)
        assert int(frame.to_ndarray(format="rgb24").max()) == 0
    assert idle[0].pts < idle[1].pts < idle[2].pts
    pending = asyncio.ensure_future(track.recv())
    await asyncio.sleep(0.01)
    source.capture_frame(RelayVideoFrame(64, 48, "rgb24", gradient(64, 48).tobytes()))
    content = await asyncio.wait_for(pending, 0.04)  # sooner than the next idle frame
    assert int(content.to_ndarray(format="rgb24").max()) > 0 and content.pts > idle[2].pts
    # Once the camera has a picture, no black frame follows: the track waits for the next capture.
    with pytest.raises(asyncio.TimeoutError):
        await asyncio.wait_for(track.recv(), 0.2)
    assert sender.stats().frames_captured == 1 and sender.stats().frames_sent == 1


class FakeVideoTrack:
    def __init__(self, frames: int) -> None:
        self.left = frames

    async def recv(self) -> av.VideoFrame:
        if self.left == 0:
            await asyncio.sleep(3600)
        self.left -= 1
        f = av.VideoFrame.from_ndarray(gradient(64, 48), format="rgb24").reformat(format="yuv420p")
        f.pts, f.time_base = 3000 * (3 - self.left), fractions.Fraction(1, 90_000)
        return f


async def test_the_remote_track_yields_neutral_i420_frame_events() -> None:
    remote = RemoteVideoTrack()
    stream = VideoStream(remote)
    remote._attach(FakeVideoTrack(3))  # type: ignore[arg-type]
    events = [await asyncio.wait_for(stream.__anext__(), 2) for _ in range(3)]
    assert all(isinstance(e, VideoFrameEvent) and e.frame.format == "i420" for e in events)
    assert [e.timestamp_us for e in events] == [33_333, 66_666, 100_000]
    assert remote.stats().frames_decoded == 3
    remote._end()
    with pytest.raises(StopAsyncIteration):
        await stream.__anext__()


async def test_the_transport_is_an_emitter_and_makes_neutral_remote_tracks() -> None:
    transport = RelayCallTransport(api_key="token", call_id="call_1")
    assert isinstance(transport, EventEmitter)
    assert type(transport._new_remote_video_track()) is RemoteVideoTrack
    transport.close()


async def test_the_offer_does_not_wait_for_stun() -> None:
    # aioice waits up to 5 s for a STUN answer on every IPv4 interface before
    # aiortc lets the offer out; the SFU is ICE-lite and never uses the
    # server-reflexive candidate, so the peer is built with TURN URLs only.
    servers = [
        RelayIceServer(urls="stun:192.0.2.1:3478"),
        RelayIceServer(urls=["stun:192.0.2.1:3478", "turn:192.0.2.1:3478?transport=udp"], username="u", credential="c"),
    ]
    assert turn_only(servers) == [RelayIceServer(urls=["turn:192.0.2.1:3478?transport=udp"], username="u", credential="c")]
    peer = create_peer_connection(PeerConfig(ice_servers=servers[:1]))
    peer.addTransceiver("audio", direction="sendonly")
    started = time.monotonic()
    await peer.setLocalDescription(await peer.createOffer())
    assert time.monotonic() - started < 1
    assert "typ srflx" not in peer.localDescription.sdp
    await peer.close()


def test_media_ssrc_reads_the_fid_group_then_the_first_ssrc() -> None:
    sdp = (
        "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:0\r\na=ssrc:7 cname:x\r\n"
        "m=video 9 UDP/TLS/RTP/SAVPF 96 97\r\na=mid:1\r\na=ssrc:11 cname:x\r\na=ssrc-group:FID 22 33\r\n"
    )
    assert media_ssrc(sdp, "1") == 22
    assert media_ssrc(sdp, "0") == 7
    assert media_ssrc(sdp, "2") is None


class FakeReceiver:
    def __init__(self) -> None:
        self.packets = 0
        self.plis: list[tuple[float, int]] = []

    async def getStats(self) -> dict[str, Any]:
        stat = type("Stat", (), {"type": "inbound-rtp", "packetsReceived": self.packets, "ssrc": 99})()
        return {"inbound": stat}

    async def _send_rtcp_pli(self, ssrc: int) -> None:
        self.plis.append((time.monotonic(), ssrc))


async def test_a_subscribed_video_asks_for_keyframes_until_one_decodes() -> None:
    # libwebrtc's rule (video_receive_stream2.cc): packets arriving but no frame
    # decoded for 200 ms -> PLI, repeated every 200 ms; 3 s once frames flow.
    receiver = FakeReceiver()
    transceiver = type("T", (), {"receiver": receiver, "mid": "1"})()
    peer = type("P", (), {"remoteDescription": type("D", (), {"sdp": "v=0\r\nm=video 9 X 96\r\na=mid:1\r\na=ssrc:42 cname:x\r\n"})()})()
    remote = RemoteVideoTrack()
    task = asyncio.ensure_future(request_keyframes(peer, transceiver, remote))
    await asyncio.sleep(0.5)
    assert receiver.plis == []  # no packets yet: nothing to ask for
    receiver.packets = 10
    await asyncio.sleep(1.05)
    times = [t for t, _ in receiver.plis]
    assert [s for _, s in receiver.plis][:1] == [42]
    assert 3 <= len(times) <= 6
    assert all(0.15 < b - a < 0.45 for a, b in zip(times, times[1:]))
    assert remote.stats().keyframe_requests == len(times)
    remote._frames_decoded = 1
    await asyncio.sleep(0.5)
    asked = len(receiver.plis)
    receiver.packets = 20
    await asyncio.sleep(1.0)
    assert len(receiver.plis) == asked  # frames decode: no request inside 3 s
    task.cancel()
