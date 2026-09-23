"""Call video, carried by aiortc, in a framework-neutral frame type.

Twin of `packages/livekit/src/video.ts`. The names copy `livekit.rtc`, the
shape every Relay adapter already speaks: `VideoSource.capture_frame(frame,
timestamp_us=, rotation=)`, `LocalVideoTrack.create_video_track(name,
source)`, `VideoStream(track)` yielding `VideoFrameEvent`. Frames here are
`RelayVideoFrame` (tightly packed bytes plus a format name) or PyAV's
`av.VideoFrame`; framework adapters override `VideoSource._to_av` and
`RemoteVideoTrack._event` to speak their own frame class instead. aiortc does
the encoding (libx264 via PyAV, H.264 constrained baseline ``42e01f``, the
profile Cloudflare's SFU accepts) and the decoding (H.264 and VP8).
"""

from __future__ import annotations

import asyncio
import fractions
import time
from collections import deque
from dataclasses import dataclass
from typing import Any, AsyncIterator, Literal, Optional

import av
import numpy as np
from aiortc.mediastreams import MediaStreamError, MediaStreamTrack

from ._engine import media_ssrc

VIDEO_TIME_BASE = fractions.Fraction(1, 90_000)

#: libwebrtc's receive-side waits for a decodable frame: 200 ms while a
#: keyframe is needed, 3 s otherwise (video/video_receive_stream2.h
#: ``kMaxWaitForKeyFrame``, ``kMaxWaitForFrame``), and the 5 s after the last
#: packet during which a stream counts as active (video_receive_stream2.cc
#: ``kInactiveDuration``).
KEYFRAME_WAIT_MS = 200
FRAME_WAIT_MS = 3_000
INACTIVE_MS = 5_000

#: Until its first captured frame, a published camera sends one black frame a
#: second. Cloudflare's SFU forwards only a track that has sent packets: a pull
#: of a silent track answers ``errorCode: "empty_track_error"`` ("No track data
#: from remote peer") after about 8 s, and the Relay room ends the Call on it
#: (staging, 2026-09-23). PartyTracks, Cloudflare's own client, sends a 1 fps
#: black screen whenever a camera has no content
#: (partytracks/src/client/makeBroadcastTrack.ts ``fallbackTrack$``,
#: blackCanvasTrack$.ts).
IDLE_FRAME_INTERVAL_S = 1.0

RelayVideoFormat = Literal["i420", "rgba", "bgra", "argb", "abgr", "rgb24"]

#: Bytes per pixel of each packed format, keyed by the PyAV pixel format of the same name.
_PACKED_DEPTH: dict[str, int] = {"rgba": 4, "bgra": 4, "argb": 4, "abgr": 4, "rgb24": 3}


@dataclass(frozen=True)
class RelayVideoFrame:
    """One tightly packed video frame: ``i420`` planes, or one packed RGB format."""

    width: int
    height: int
    format: RelayVideoFormat
    data: bytes

    def __post_init__(self) -> None:
        if self.width <= 0 or self.height <= 0:
            raise ValueError("RelayVideoFrame width and height must be positive.")
        if len(self.data) < self.byte_length(self.width, self.height, self.format):
            raise ValueError(
                f"RelayVideoFrame {self.width}x{self.height} {self.format} needs "
                f"{self.byte_length(self.width, self.height, self.format)} bytes, got {len(self.data)}."
            )

    @staticmethod
    def byte_length(width: int, height: int, format: RelayVideoFormat) -> int:
        if format == "i420":
            chroma = ((width + 1) // 2) * ((height + 1) // 2)
            return width * height + 2 * chroma
        depth = _PACKED_DEPTH.get(format)
        if depth is None:
            raise ValueError(f"Unsupported RelayVideoFrame format {format!r}.")
        return width * height * depth

    def to_av(self) -> av.VideoFrame:
        """This frame as a PyAV frame for aiortc's encoder."""
        data = np.frombuffer(self.data, dtype=np.uint8)
        if self.format == "i420":
            if self.width % 2 == 0 and self.height % 2 == 0:
                return av.VideoFrame.from_ndarray(
                    data[: self.width * self.height * 3 // 2].reshape(self.height * 3 // 2, self.width),
                    format="yuv420p",
                )
            # Odd sizes: PyAV's yuv420p planes are padded, so fill them row by row.
            frame = av.VideoFrame(self.width, self.height, "yuv420p")
            chroma = ((self.width + 1) // 2, (self.height + 1) // 2)
            offset = 0
            for plane, (w, h) in zip(frame.planes, ((self.width, self.height), chroma, chroma)):
                rows = np.frombuffer(plane, dtype=np.uint8).reshape(-1, plane.line_size)
                rows[:h, :w] = data[offset : offset + w * h].reshape(h, w)
                offset += w * h
            return frame
        depth = _PACKED_DEPTH[self.format]
        return av.VideoFrame.from_ndarray(
            data[: self.width * self.height * depth].reshape(self.height, self.width, depth), format=self.format
        )

    @classmethod
    def from_av(cls, frame: av.VideoFrame, format: RelayVideoFormat = "i420") -> "RelayVideoFrame":
        """A decoded PyAV frame as a tightly packed frame of ``format``."""
        if format == "i420":
            if frame.format.name != "yuv420p":
                frame = frame.reformat(format="yuv420p")
            parts = []
            for plane in frame.planes:
                rows = np.frombuffer(plane, dtype=np.uint8).reshape(-1, plane.line_size)
                parts.append(rows[: plane.height, : plane.width].reshape(-1))
            return cls(frame.width, frame.height, "i420", np.concatenate(parts).tobytes())
        if format not in _PACKED_DEPTH:
            raise ValueError(f"Unsupported RelayVideoFrame format {format!r}.")
        packed = frame.to_ndarray(format=format)
        return cls(frame.width, frame.height, format, np.ascontiguousarray(packed).tobytes())

    def convert(self, format: RelayVideoFormat) -> "RelayVideoFrame":
        """This frame in another format (LiveKit ``VideoFrame.convert``)."""
        if format == self.format:
            return self
        return RelayVideoFrame.from_av(self.to_av(), format)


@dataclass
class VideoFrameEvent:
    """One received frame (LiveKit ``rtc.VideoFrameEvent``)."""

    frame: RelayVideoFrame
    timestamp_us: int
    rotation: int = 0


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
    #: Captured frames aiortc's sender pulled for encoding (the idle black frames are not counted).
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
        self._latest: Optional[tuple[Any, int]] = None
        self._serial = 0
        self._changed = asyncio.Event()
        self._frames_captured = 0
        self._closed = False

    def capture_frame(self, frame: Any, *, timestamp_us: int = 0, rotation: int = 0) -> None:
        """Queue ``frame`` for the next encode; a newer frame replaces one not yet taken, as a live camera does.

        ``frame`` is a `RelayVideoFrame` or an ``av.VideoFrame``.
        """
        if self._closed:
            return
        stamp = timestamp_us or int(time.monotonic() * 1_000_000)
        self._latest = (frame, stamp)
        self._serial += 1
        self._frames_captured += 1
        self._changed.set()

    def _to_av(self, frame: Any) -> av.VideoFrame:
        """A captured frame as a PyAV frame for aiortc's encoder."""
        if isinstance(frame, av.VideoFrame):
            return frame
        if isinstance(frame, RelayVideoFrame):
            return frame.to_av()
        raise TypeError(f"VideoSource cannot encode {type(frame).__name__}; pass a RelayVideoFrame or av.VideoFrame.")

    async def aclose(self) -> None:
        self._closed = True
        self._changed.set()

    def _idle_frame(self) -> av.VideoFrame:
        """One black frame at the source's size, sent while nothing has been captured."""
        return av.VideoFrame.from_ndarray(np.zeros((self.height, self.width, 3), dtype=np.uint8), format="rgb24")

    async def _wait_first(self, timeout_s: float) -> None:
        """Return when the first frame is captured or the source closes, or after ``timeout_s``."""
        if self._latest is not None or self._closed:
            return
        self._changed.clear()
        try:
            await asyncio.wait_for(self._changed.wait(), timeout_s)
        except asyncio.TimeoutError:
            pass

    async def _next(self, after: int) -> tuple[int, Any, int]:
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
        #: When the next idle black frame is due (`IDLE_FRAME_INTERVAL_S`); the first is sent at once.
        self._idle_due = 0.0

    async def recv(self) -> av.VideoFrame:
        if self.readyState != "live":
            raise MediaStreamError
        source = self._sender.source
        while source._latest is None and not source._closed:
            wait = self._idle_due - time.monotonic()
            if wait <= 0:
                self._idle_due = time.monotonic() + IDLE_FRAME_INTERVAL_S
                idle = source._idle_frame()
                # capture_frame's default clock, so the first captured frame follows on.
                idle.pts = int(time.monotonic() * 1_000_000) * 90_000 // 1_000_000
                idle.time_base = VIDEO_TIME_BASE
                return idle
            await source._wait_first(wait)
        serial, frame, stamp = await source._next(self._serial)
        self._serial = serial
        out = self._sender.source._to_av(frame)
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

    Yields the track's event type: `VideoFrameEvent` from this package, the
    framework's own from an adapter's track. ``capacity`` 0 keeps every frame,
    as LiveKit's default does; a positive capacity drops the oldest frame when
    the reader falls behind.
    """

    def __init__(self, track: "RemoteVideoTrack", *, capacity: int = 0) -> None:
        self._track = track
        self._capacity = capacity
        self._queue: deque[Any] = deque()
        self._ready = asyncio.Event()
        self._closed = False
        track._streams.add(self)
        if track._ended:
            self._end()

    @classmethod
    def from_track(cls, *, track: "RemoteVideoTrack", capacity: int = 0) -> "VideoStream":
        return cls(track, capacity=capacity)

    def _push(self, event: Any) -> None:
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

    def __aiter__(self) -> AsyncIterator[Any]:
        return self

    async def __anext__(self) -> Any:
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
        self._keyframe_requests = 0
        self._ended = False
        self.codec: Optional[str] = None

    def stats(self) -> RelayVideoReceiverStats:
        return RelayVideoReceiverStats(
            frames_decoded=self._frames_decoded,
            frames_dropped=self._frames_dropped,
            codec=self.codec,
            keyframe_requests=self._keyframe_requests,
        )

    def _event(self, frame: av.VideoFrame, timestamp_us: int) -> Any:
        """The event a `VideoStream` yields for one decoded frame; adapters override it."""
        return VideoFrameEvent(frame=RelayVideoFrame.from_av(frame), timestamp_us=timestamp_us)

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
            event = self._event(frame, timestamp_us)
            for stream in list(self._streams):
                stream._push(event)


async def request_keyframes(peer: Any, transceiver: Any, remote: RemoteVideoTrack) -> None:
    """Ask the sender for keyframes on the rule libwebrtc's receiver uses, for as long as the track is attached.

    aiortc's receiver asks only when its jitter buffer overflows
    (aiortc/rtcrtpreceiver.py ``_handle_rtp_packet``), so a track pulled after
    the sender's first keyframe decodes nothing until the encoder's next
    periodic one (libx264 by default every 250 frames). libwebrtc requests a
    keyframe when no frame has decoded for 200 ms while a keyframe is needed
    (from the start of the stream, and after any request) or for 3 s
    otherwise, if a packet arrived in the last 5 s, and repeats the request at
    most every 200 ms (video_receive_stream2.cc ``HandleFrameBufferTimeout``,
    ``OnEncodedFrame``). The request is an RTCP PLI for the section's media
    SSRC, sent with aiortc's own PLI writer (``RTCRtpReceiver._send_rtcp_pli``).
    """
    receiver = transceiver.receiver
    loop = asyncio.get_running_loop()
    keyframe_required = True
    decoded = remote._frames_decoded
    progress_at = loop.time()
    packets, packets_at = 0, None
    while True:
        await asyncio.sleep(KEYFRAME_WAIT_MS / 1000)
        now = loop.time()
        if remote._frames_decoded != decoded:
            decoded = remote._frames_decoded
            progress_at = now
            keyframe_required = False
            continue
        inbound = [s for s in (await receiver.getStats()).values() if getattr(s, "type", None) == "inbound-rtp"]
        received = sum(s.packetsReceived for s in inbound)
        if received > packets:
            packets, packets_at = received, now
        wait_ms = KEYFRAME_WAIT_MS if keyframe_required else FRAME_WAIT_MS
        if (now - progress_at) * 1000 < wait_ms or packets_at is None or (now - packets_at) * 1000 >= INACTIVE_MS:
            continue
        description = peer.remoteDescription
        ssrc = media_ssrc(description.sdp, transceiver.mid) if description is not None else None
        if ssrc is None and inbound:
            ssrc = inbound[0].ssrc
        if ssrc is None:
            continue
        await receiver._send_rtcp_pli(ssrc)
        remote._keyframe_requests += 1
        keyframe_required = True
        progress_at = now
