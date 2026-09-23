"""Video in LiveKit's Python shapes, carried by aiortc.

Twin of `packages/livekit/src/video.ts`. Frames are LiveKit's own
`livekit.rtc.VideoFrame` both ways, so a frame read here can go straight to an
`AgentSession` (Gemini Live samples it) and a frame an application already has
for LiveKit can be sent unchanged. The names copy `livekit.rtc`:
`VideoSource.capture_frame(frame, timestamp_us=, rotation=)`,
`LocalVideoTrack.create_video_track(name, source)`, `VideoStream(track)`
yielding `VideoFrameEvent`. aiortc does the encoding (libx264 via PyAV, H.264
constrained baseline ``42e01f``, the profile Cloudflare's SFU accepts) and the
decoding (H.264 and VP8).
"""

from __future__ import annotations

import asyncio
import fractions
import time
from collections import deque
from dataclasses import dataclass
from typing import Any, AsyncIterator, Optional, cast

import av
import numpy as np
from aiortc.mediastreams import MediaStreamError, MediaStreamTrack
from livekit import rtc

VIDEO_TIME_BASE = fractions.Fraction(1, 90_000)

_PACKED_FORMATS: dict[int, tuple[str, int]] = {
    rtc.VideoBufferType.RGBA: ("rgba", 4),
    rtc.VideoBufferType.BGRA: ("bgra", 4),
    rtc.VideoBufferType.ARGB: ("argb", 4),
    rtc.VideoBufferType.ABGR: ("abgr", 4),
    rtc.VideoBufferType.RGB24: ("rgb24", 3),
}


def to_av_frame(frame: rtc.VideoFrame) -> av.VideoFrame:
    """A LiveKit frame as a PyAV frame for aiortc's encoder, without copying through the LiveKit FFI when avoidable."""
    width, height, kind = frame.width, frame.height, frame.type
    data = np.frombuffer(frame.data, dtype=np.uint8)
    if kind == rtc.VideoBufferType.I420 and width % 2 == 0 and height % 2 == 0:
        return av.VideoFrame.from_ndarray(data[: width * height * 3 // 2].reshape(height * 3 // 2, width), format="yuv420p")
    packed = _PACKED_FORMATS.get(kind)
    if packed is not None:
        name, depth = packed
        return av.VideoFrame.from_ndarray(data[: width * height * depth].reshape(height, width, depth), format=name)
    # Anything else (NV12, odd-sized I420, ...) goes through LiveKit's own converter.
    return to_av_frame(frame.convert(rtc.VideoBufferType.RGBA))


def to_rtc_frame(frame: av.VideoFrame) -> rtc.VideoFrame:
    """A decoded PyAV frame as a tightly packed I420 LiveKit frame."""
    if frame.format.name != "yuv420p":
        frame = frame.reformat(format="yuv420p")
    parts = []
    for plane in frame.planes:
        rows = np.frombuffer(plane, dtype=np.uint8).reshape(-1, plane.line_size)
        parts.append(rows[: plane.height, : plane.width].reshape(-1))
    return rtc.VideoFrame(frame.width, frame.height, rtc.VideoBufferType.I420, np.concatenate(parts).tobytes())


@dataclass
class VideoEncoding:
    """LiveKit's ``VideoEncoding``. aiortc adapts its bitrate from REMB; these are recorded for parity."""

    max_bitrate: int = 0
    max_framerate: float = 0


@dataclass
class TrackPublishOptions:
    video_encoding: Optional[VideoEncoding] = None


@dataclass
class RelayVideoSenderStats:
    #: Frames handed to `VideoSource.capture_frame` while published.
    frames_captured: int
    #: Frames aiortc's sender pulled for encoding.
    frames_sent: int
    #: Negotiated codec, for example ``"video/H264"``; ``None`` before the answer.
    codec: Optional[str]
    keyframes: Optional[int] = None
    keyframe_requests: Optional[int] = None


@dataclass
class RelayVideoReceiverStats:
    #: Frames aiortc decoded.
    frames_decoded: int
    #: Frames not delivered because a `VideoStream` was full.
    frames_dropped: int
    codec: Optional[str]
    decode_errors: Optional[int] = None
    keyframe_requests: Optional[int] = None


class VideoSource:
    """The camera feed an application sends (LiveKit ``rtc.VideoSource``)."""

    def __init__(self, width: int, height: int, *, is_screencast: bool = False) -> None:
        self.width = width
        self.height = height
        self.is_screencast = is_screencast
        self._latest: Optional[tuple[rtc.VideoFrame, int]] = None
        self._serial = 0
        self._changed = asyncio.Event()
        self._frames_captured = 0
        self._closed = False

    def capture_frame(
        self,
        frame: rtc.VideoFrame,
        *,
        timestamp_us: int = 0,
        rotation: int = rtc.VideoRotation.VIDEO_ROTATION_0,
    ) -> None:
        """Queue ``frame`` for the next encode; a newer frame replaces one not yet taken, as a live camera does."""
        if self._closed:
            return
        stamp = timestamp_us or int(time.monotonic() * 1_000_000)
        self._latest = (frame, stamp)
        self._serial += 1
        self._frames_captured += 1
        self._changed.set()

    async def aclose(self) -> None:
        self._closed = True
        self._changed.set()

    async def _next(self, after: int) -> tuple[int, rtc.VideoFrame, int]:
        while True:
            if self._closed:
                raise MediaStreamError
            if self._serial > after and self._latest is not None:
                frame, stamp = self._latest
                return self._serial, frame, stamp
            self._changed.clear()
            await self._changed.wait()


class LocalVideoTrack:
    """LiveKit ``rtc.LocalVideoTrack``: a named track over one `VideoSource`."""

    def __init__(self, name: str, source: VideoSource) -> None:
        self.name = name
        self.source = source
        self.kind = "video"

    @staticmethod
    def create_video_track(name: str, source: VideoSource) -> "LocalVideoTrack":
        return LocalVideoTrack(name, source)


class _SenderTrack(MediaStreamTrack):
    """One peer's view of the published `VideoSource`; aiortc's sender pulls it and encodes."""

    kind = "video"

    def __init__(self, sender: "_VideoSender") -> None:
        super().__init__()
        self._sender = sender
        self._serial = 0

    async def recv(self) -> av.VideoFrame:
        if self.readyState != "live":
            raise MediaStreamError
        serial, frame, stamp = await self._sender.source._next(self._serial)
        self._serial = serial
        out = to_av_frame(frame)
        out.pts = stamp * 90_000 // 1_000_000
        out.time_base = VIDEO_TIME_BASE
        self._sender.frames_sent += 1
        return out


class _VideoSender:
    """The published camera across every peer of the call."""

    def __init__(self, track: LocalVideoTrack, options: TrackPublishOptions) -> None:
        self.track = track
        self.source = track.source
        self.options = options
        self.frames_sent = 0
        self.codec: Optional[str] = None
        self.enabled = True
        self._captured_at_publish = track.source._frames_captured

    def create_track(self) -> _SenderTrack:
        return _SenderTrack(self)

    def stats(self) -> RelayVideoSenderStats:
        return RelayVideoSenderStats(
            frames_captured=self.source._frames_captured - self._captured_at_publish,
            frames_sent=self.frames_sent,
            codec=self.codec,
        )


class VideoStream:
    """Frames of a `RemoteVideoTrack` (LiveKit ``rtc.VideoStream``): ``async for event in VideoStream(track)``.

    ``capacity`` 0 keeps every frame, as LiveKit's default does; a positive
    capacity drops the oldest frame when the reader falls behind.
    """

    def __init__(self, track: "RemoteVideoTrack", *, capacity: int = 0) -> None:
        self._track = track
        self._capacity = capacity
        self._queue: deque[Optional[rtc.VideoFrameEvent]] = deque()
        self._ready = asyncio.Event()
        self._closed = False
        track._streams.add(self)
        if track._ended:
            self._end()

    @classmethod
    def from_track(cls, *, track: "RemoteVideoTrack", capacity: int = 0) -> "VideoStream":
        return cls(track, capacity=capacity)

    def _push(self, event: rtc.VideoFrameEvent) -> None:
        if self._closed:
            return
        if self._capacity > 0 and len(self._queue) >= self._capacity:
            self._queue.popleft()
            self._track._frames_dropped += 1
        self._queue.append(event)
        self._ready.set()

    def _end(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._queue.append(None)
        self._ready.set()

    def __aiter__(self) -> AsyncIterator[rtc.VideoFrameEvent]:
        return self

    async def __anext__(self) -> rtc.VideoFrameEvent:
        while not self._queue:
            self._ready.clear()
            await self._ready.wait()
        event = self._queue.popleft()
        if event is None:
            self._queue.append(None)
            raise StopAsyncIteration
        return event

    async def aclose(self) -> None:
        self._track._streams.discard(self)
        self._end()


class RemoteVideoTrack:
    """The other participant's camera (LiveKit ``rtc.RemoteVideoTrack``), one per call, kept across restarts."""

    kind = "video"

    def __init__(self) -> None:
        self._streams: set[VideoStream] = set()
        self._receiver: Optional[asyncio.Task[None]] = None
        self._frames_decoded = 0
        self._frames_dropped = 0
        self._ended = False
        self.codec: Optional[str] = None

    def stats(self) -> RelayVideoReceiverStats:
        return RelayVideoReceiverStats(
            frames_decoded=self._frames_decoded, frames_dropped=self._frames_dropped, codec=self.codec
        )

    def _attach(self, track: MediaStreamTrack) -> None:
        self._detach()
        self._receiver = asyncio.get_running_loop().create_task(self._read(track))

    def _detach(self) -> None:
        if self._receiver is not None:
            self._receiver.cancel()
            self._receiver = None

    def _end(self) -> None:
        self._detach()
        self._ended = True
        for stream in list(self._streams):
            stream._end()

    async def _read(self, track: MediaStreamTrack) -> None:
        # aiortc queues every decoded frame until someone calls recv(), so the
        # track is always drained; frames are converted only for open streams.
        while True:
            try:
                frame: Any = await track.recv()
            except (MediaStreamError, asyncio.CancelledError):
                return
            self._frames_decoded += 1
            if not self._streams or not isinstance(frame, av.VideoFrame):
                continue
            timestamp_us = int(frame.pts * frame.time_base * 1_000_000) if frame.pts is not None and frame.time_base else 0
            event = rtc.VideoFrameEvent(
                frame=to_rtc_frame(frame),
                timestamp_us=timestamp_us,
                rotation=cast(Any, rtc.VideoRotation.VIDEO_ROTATION_0),
            )
            for stream in list(self._streams):
                stream._push(event)
