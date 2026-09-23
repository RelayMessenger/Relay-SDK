"""The framework-neutral pieces the adapters share: the event emitter and video frames."""

from __future__ import annotations

import asyncio
import fractions
import sys
from typing import Any

import av
import numpy as np
import pytest

from relaymessenger_calls import (
    EventEmitter,
    LocalVideoTrack,
    RelayCallTransport,
    RelayVideoFrame,
    RemoteVideoTrack,
    VideoFrameEvent,
    VideoSource,
    VideoStream,
)
from relaymessenger_calls.video import TrackPublishOptions, _VideoSender


def test_the_core_imports_no_livekit() -> None:
    assert not [name for name in sys.modules if name == "livekit" or name.startswith("livekit.")]


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
