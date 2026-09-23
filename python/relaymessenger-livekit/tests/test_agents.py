"""LiveKit bridge: audio format in, ParticipantAudioOutput semantics out, camera frames to the session."""

from __future__ import annotations

import asyncio
import fractions
from typing import Any

import av
import numpy as np
import pytest
from aiortc.mediastreams import MediaStreamError
from livekit import rtc

from relaymessenger_livekit import LIVEKIT_ROOM_INPUT_AUDIO, RelayAudioInput, RelayAudioOutput, RelayVideoInput
from relaymessenger.calls._audio import RelayAudioSink
from relaymessenger_livekit.transport import RelayAudioFrame
from relaymessenger_livekit.video import RemoteVideoTrack


class FakeTransport(rtc.EventEmitter[str]):
    def __init__(self) -> None:
        super().__init__()
        self.written: list[RelayAudioFrame] = []
        self.queued_ms = 0.0
        self.cleared = 0
        self.playout = asyncio.get_running_loop().create_future()
        self.remote_video_track: Any = None

    async def write_audio(self, frame: RelayAudioFrame) -> None:
        self.written.append(frame)
        self.queued_ms += frame.samples.size / frame.channel_count / frame.sample_rate * 1000

    def queued_audio_ms(self) -> float:
        return self.queued_ms

    def clear_audio(self) -> None:
        self.cleared += 1
        self.queued_ms = 0
        if not self.playout.done():
            self.playout.set_result(None)

    async def wait_for_playout(self) -> None:
        await asyncio.shield(self.playout)


def frame(ms: int, rate: int = 24_000) -> rtc.AudioFrame:
    n = rate * ms // 1000
    return rtc.AudioFrame(data=np.full(n, 100, dtype=np.int16).tobytes(), sample_rate=rate, num_channels=1, samples_per_channel=n)


async def settle() -> None:
    for _ in range(10):
        await asyncio.sleep(0)


def test_session_input_is_24_khz_mono_like_livekit_room_input() -> None:
    assert (LIVEKIT_ROOM_INPUT_AUDIO.sample_rate, LIVEKIT_ROOM_INPUT_AUDIO.channel_count) == (24_000, 1)


async def test_output_capture_returns_at_once_and_flush_finishes_after_drain() -> None:
    transport = FakeTransport()
    output = RelayAudioOutput(transport)  # type: ignore[arg-type]
    finished, started = [], []
    output.on("playback_finished", finished.append)
    output.on("playback_started", started.append)
    for _ in range(50):
        await output.capture_frame(frame(20))  # 1 s pushed far faster than real time
    assert len(started) == 1 and len(transport.written) == 50
    output.flush()
    await settle()
    assert finished == []
    transport.playout.set_result(None)
    await settle()
    assert len(finished) == 1
    assert finished[0].interrupted is False and finished[0].playback_position == pytest.approx(1.0)


async def test_clear_buffer_reports_interrupted_at_the_played_position() -> None:
    transport = FakeTransport()
    output = RelayAudioOutput(transport)  # type: ignore[arg-type]
    finished = []
    output.on("playback_finished", finished.append)
    for _ in range(50):
        await output.capture_frame(frame(20))
    transport.queued_ms = 400  # 600 ms has left, 400 ms is still queued
    output.clear_buffer()
    await settle()
    assert transport.cleared == 1
    assert finished[0].interrupted is True
    assert finished[0].playback_position == pytest.approx(0.6)
    # The next segment starts clean.
    transport.playout = asyncio.get_running_loop().create_future()
    await output.capture_frame(frame(20))
    output.flush()
    transport.playout.set_result(None)
    await settle()
    assert finished[1].interrupted is False and finished[1].playback_position == pytest.approx(0.02)


async def test_audio_input_hands_the_session_rtc_frames_and_drops_while_detached() -> None:
    transport = FakeTransport()
    audio_in = RelayAudioInput(transport)  # type: ignore[arg-type]
    samples = np.arange(480, dtype=np.int16)
    transport.emit("audio", RelayAudioFrame(samples, 24_000, 1))
    got = await asyncio.wait_for(audio_in.__anext__(), 1)
    assert (got.sample_rate, got.num_channels, got.samples_per_channel) == (24_000, 1, 480)
    assert np.array_equal(np.frombuffer(got.data, dtype=np.int16), samples)
    audio_in.on_detached()
    transport.emit("audio", RelayAudioFrame(samples, 24_000, 1))
    audio_in.on_attached()
    transport.emit("audio", RelayAudioFrame(samples + 1, 24_000, 1))
    got = await asyncio.wait_for(audio_in.__anext__(), 1)
    assert int(np.frombuffer(got.data, dtype=np.int16)[0]) == 1
    await audio_in.aclose()


class FakeAudioTrack:
    """aiortc's decoded remote audio: 20 ms, 48 kHz stereo s16 (aiortc/codecs/opus.py OpusDecoder)."""

    def __init__(self, frames: int) -> None:
        self.left = frames
        self.pts = 0

    async def recv(self) -> av.AudioFrame:
        if self.left == 0:
            raise MediaStreamError
        self.left -= 1
        t = (np.arange(960) + self.pts) / 48_000
        tone = (np.sin(2 * np.pi * 440 * t) * 9000).astype(np.int16)
        f = av.AudioFrame.from_ndarray(np.repeat(tone, 2).reshape(1, -1), format="s16", layout="stereo")
        f.sample_rate = 48_000
        f.pts = self.pts
        f.time_base = fractions.Fraction(1, 48_000)
        self.pts += 960
        return f


async def test_sink_converts_48k_stereo_to_the_requested_24k_mono() -> None:
    out: list[tuple[np.ndarray, int, int]] = []
    sink = RelayAudioSink(FakeAudioTrack(50), 24_000, 1, lambda s, r, c: out.append((s, r, c)))  # type: ignore[arg-type]
    await asyncio.wait_for(sink._task, 2)
    assert all(r == 24_000 and c == 1 for _, r, c in out)
    pcm = np.concatenate([s for s, _, _ in out])
    assert pcm.dtype == np.int16
    assert pcm.size == pytest.approx(24_000, abs=480)  # 1 s of mono at 24 kHz
    crossings = np.count_nonzero(np.diff(np.signbit(pcm[2400:-2400].astype(np.int32))))
    assert crossings / 2 / ((pcm.size - 4800) / 24_000) == pytest.approx(440, rel=0.03)
    assert sink.stats().rtp_packets == 50


class FakeVideoTrack:
    def __init__(self, frames: int) -> None:
        self.left = frames

    async def recv(self) -> av.VideoFrame:
        if self.left == 0:
            await asyncio.sleep(3600)
        self.left -= 1
        rgb = np.zeros((48, 64, 3), dtype=np.uint8)
        rgb[..., 0] = 220
        f = av.VideoFrame.from_ndarray(rgb, format="rgb24").reformat(format="yuv420p")
        f.pts, f.time_base = 3000 * (5 - self.left), fractions.Fraction(1, 90_000)
        return f


async def test_video_input_yields_i420_rtc_frames_of_the_remote_camera() -> None:
    transport = FakeTransport()
    video_in = RelayVideoInput(transport)  # type: ignore[arg-type]
    remote = RemoteVideoTrack()
    transport.remote_video_track = remote
    transport.emit("track_subscribed", remote)
    remote._attach(FakeVideoTrack(5))  # type: ignore[arg-type]
    frames = [await asyncio.wait_for(video_in.__anext__(), 2) for _ in range(5)]
    assert all(isinstance(f, rtc.VideoFrame) and f.type == rtc.VideoBufferType.I420 for f in frames)
    assert (frames[0].width, frames[0].height, len(frames[0].data)) == (64, 48, 64 * 48 * 3 // 2)
    assert remote.stats().frames_decoded == 5
    await video_in.aclose()
    remote._end()


async def test_attach_sets_a_real_agent_sessions_audio_video_and_output() -> None:
    from livekit.agents import AgentSession

    from relaymessenger_livekit import RelayLiveKitCall

    transport = FakeTransport()
    call = RelayLiveKitCall(transport)  # type: ignore[arg-type]
    session = AgentSession()
    call.attach(session)
    assert session.input.audio is call.input
    assert session.input.video is call.video_input
    assert session.output.audio is call.output
    call.detach()
    assert session.input.audio is None and session.input.video is None and session.output.audio is None
    await call.input.aclose()
    await call.video_input.aclose()


def test_connect_takes_no_ice_transport_policy() -> None:
    import inspect

    from relaymessenger_livekit import RelayLiveKitCall

    # aiortc has no public iceTransportPolicy.
    assert "ice_transport_policy" not in inspect.signature(RelayLiveKitCall.connect).parameters
