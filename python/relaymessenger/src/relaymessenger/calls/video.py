"""Call video, carried by aiortc, in a framework-neutral frame type.

Twin of `packages/livekit/src/video.ts`. The names copy `livekit.rtc`, the
shape every Relay adapter already speaks: `VideoSource.capture_frame(frame,
timestamp_us=, rotation=)`, `LocalVideoTrack.create_video_track(name,
source)`, `VideoStream(track)` yielding `VideoFrameEvent`. Frames here are
`RelayVideoFrame` (tightly packed bytes plus a format name) or PyAV's
`av.VideoFrame`; framework adapters override `VideoSource._to_av` and
`RemoteVideoTrack._event` to speak their own frame class instead. aiortc does
the encoding (libx264 via PyAV, H.264 constrained baseline, the profile
Cloudflare's SFU accepts, through `RelayH264Encoder`) and the decoding (H.264
and VP8).
"""

from __future__ import annotations

import asyncio
import fractions
import time
from collections import deque
from dataclasses import dataclass
from typing import Any, AsyncIterator, Callable, Literal, Optional

import av
import numpy as np
from aiortc.codecs.h264 import MAX_FRAME_RATE, H264Encoder
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

#: A keyframe request (PLI or FIR from the SFU, or the other participant
#: starting to receive this camera) sends the latest frame again at once, as a
#: keyframe, unless a frame went out within one frame period (30 fps, aiortc's
#: ``MAX_FRAME_RATE`` in codecs/h264.py and codecs/vpx.py): the next frame is
#: then about to follow. libwebrtc does the same for a source that repeats its
#: last frame about once a second (video/frame_cadence_adapter.cc
#: ``ZeroHertzAdapterMode::ProcessKeyFrameRequest``: "Cancel the current repeat
#: and reschedule a short repeat now"). Without it a camera at 1 fps, the idle
#: black frames or an application's placeholder picture, answers a request only
#: with its next frame, up to 1 s later (staging, 2026-09-23).
KEYFRAME_REPEAT_AFTER_S = 1 / 30

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
    """LiveKit's ``VideoEncoding``: the encoder's bitrate ceiling and framerate hint.

    A field left at 0 takes LiveKit's camera preset for the frame size being
    sent (`default_video_encoding`). aiortc sets the bitrate from the SFU's
    REMB estimate, between 500 kbps and 3 Mbps (aiortc/codecs/h264.py
    ``MIN_BITRATE``, ``MAX_BITRATE``); `RelayH264Encoder` keeps it at or below
    ``max_bitrate``.
    """

    max_bitrate: int = 0
    max_framerate: float = 0


#: LiveKit's camera presets, ``(width, height, max_bitrate, max_framerate)``:
#: ``VideoPresets`` (16:9) and ``VideoPresets43`` (4:3) in livekit/client-sdk-js
#: src/room/track/options.ts:507-532 at 5cadc938
#: (https://github.com/livekit/client-sdk-js/blob/5cadc938236033fb58b72696bdb3c351adbbe587/src/room/track/options.ts#L507-L532),
#: the same table as packages/sdk/src/calls/video-presets.ts.
VIDEO_PRESETS_169: tuple[tuple[int, int, int, float], ...] = (
    (160, 90, 90_000, 20),
    (320, 180, 160_000, 20),
    (384, 216, 180_000, 20),
    (640, 360, 450_000, 20),
    (960, 540, 800_000, 25),
    (1280, 720, 1_700_000, 30),
    (1920, 1080, 3_000_000, 30),
    (2560, 1440, 5_000_000, 30),
    (3840, 2160, 8_000_000, 30),
)
VIDEO_PRESETS_43: tuple[tuple[int, int, int, float], ...] = (
    (160, 120, 70_000, 20),
    (240, 180, 125_000, 20),
    (320, 240, 140_000, 20),
    (480, 360, 330_000, 20),
    (640, 480, 500_000, 20),
    (720, 540, 600_000, 25),
    (960, 720, 1_300_000, 30),
    (1440, 1080, 2_300_000, 30),
    (1920, 1440, 3_800_000, 30),
)


def default_video_encoding(width: int, height: int) -> VideoEncoding:
    """LiveKit's ``determineAppropriateEncoding`` for a camera frame of ``width`` x ``height``.

    livekit/client-sdk-js src/room/participant/publishUtils.ts:310-368 at
    5cadc938: the 16:9 or 4:3 list, whichever aspect ratio is nearer; the
    first preset whose width reaches the frame's longer side, else the
    largest. LiveKit changes the bitrate only for VP9, AV1 and H.265.
    """
    aspect = width / height if width > height else height / width
    presets = VIDEO_PRESETS_169 if abs(aspect - 16 / 9) < abs(aspect - 4 / 3) else VIDEO_PRESETS_43
    size = max(width, height)
    chosen = presets[0]
    for chosen in presets:
        if chosen[0] >= size:
            break
    return VideoEncoding(max_bitrate=chosen[2], max_framerate=chosen[3])


class RelayH264Encoder(H264Encoder):
    """aiortc's H.264 encoder with LiveKit's encoding and the level libx264 picks for the frame.

    aiortc opens libx264 at level 3.1 whatever the frame size
    (aiortc/codecs/h264.py ``_encode_frame``: ``"level": "31"``), so a 1080p
    stream says 3.1 in its SPS. This encoder opens libx264 the same way but
    leaves the level out, and libx264 picks it from the frame size and rate,
    as libwebrtc leaves it to OpenH264
    (modules/video_coding/codecs/h264/h264_encoder_impl.cc sets no level):
    3.1 at 1280x720 and 4.0 at 1920x1080 at 30 fps. The bitrate is aiortc's
    REMB estimate, at most the encoding's ``max_bitrate``; the framerate hint
    is the encoding's ``max_framerate``.
    """

    def __init__(self, encoding: Optional[VideoEncoding] = None) -> None:
        super().__init__()
        self.encoding = encoding or VideoEncoding()
        self._max_bitrate = 0

    def settings(self, width: int, height: int) -> VideoEncoding:
        """The encoding for one frame size: each field the caller set, else LiveKit's preset."""
        preset = default_video_encoding(width, height)
        return VideoEncoding(
            max_bitrate=self.encoding.max_bitrate or preset.max_bitrate,
            max_framerate=self.encoding.max_framerate or preset.max_framerate,
        )

    @property
    def target_bitrate(self) -> int:
        estimate = int(H264Encoder.target_bitrate.fget(self))  # type: ignore[attr-defined]
        return min(estimate, self._max_bitrate) if self._max_bitrate else estimate

    @target_bitrate.setter
    def target_bitrate(self, bitrate: int) -> None:
        H264Encoder.target_bitrate.fset(self, bitrate)  # type: ignore[attr-defined]

    def _encode_frame(self, frame: av.VideoFrame, force_keyframe: bool) -> Any:
        settings = self.settings(frame.width, frame.height)
        self._max_bitrate = settings.max_bitrate
        codec = self.codec
        # aiortc's own reopen rule: a new size, or a bitrate more than 10% away.
        if codec is None or (
            frame.width != codec.width
            or frame.height != codec.height
            or not codec.bit_rate
            or abs(self.target_bitrate - codec.bit_rate) / codec.bit_rate > 0.1
        ):
            self.buffer_data = b""
            self.buffer_pts = None
            codec = av.CodecContext.create("libx264", "w")
            codec.width = frame.width
            codec.height = frame.height
            codec.bit_rate = self.target_bitrate
            codec.pix_fmt = "yuv420p"
            codec.framerate = fractions.Fraction(settings.max_framerate).limit_denominator(1001)
            # aiortc's time base, unchanged: frames keep arriving at the caller's pace.
            codec.time_base = fractions.Fraction(1, MAX_FRAME_RATE)
            codec.options = {"tune": "zerolatency"}
            codec.profile = "Baseline"
            self.codec = codec
        return super()._encode_frame(frame, force_keyframe)


def use_relay_encoder(sender: Any, encoding: Optional[VideoEncoding]) -> None:
    """Give an aiortc video sender a `RelayH264Encoder` before its first frame.

    aiortc creates the encoder on the first frame only when it has none
    (aiortc/rtcrtpsender.py ``_next_encoded_frame``: ``if self.__encoder is
    None``) and releases it when the sender stops; the published video offers
    H.264 alone (`prefer_h264`), so the encoder is always H.264.
    """
    sender._RTCRtpSender__encoder = RelayH264Encoder(encoding)


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

    async def _wait(self, timeout_s: Optional[float]) -> None:
        """Return on the next capture, close or wake-up, or after ``timeout_s``; callers check what changed."""
        try:
            await asyncio.wait_for(self._changed.wait(), timeout_s)
        except asyncio.TimeoutError:
            pass
        self._changed.clear()


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
        #: A keyframe request asked for the latest frame again (`KEYFRAME_REPEAT_AFTER_S`).
        self._repeat = False
        #: pts of the last frame handed to the encoder, and when it was handed over.
        self._last_pts: Optional[int] = None
        self._last_sent_at = float("-inf")

    def request_keyframe(self) -> None:
        """Send the latest frame again now unless a frame went out within one frame period."""
        self._sender.keyframe_requests += 1
        if time.monotonic() - self._last_sent_at < KEYFRAME_REPEAT_AFTER_S:
            return
        self._repeat = True
        self._sender.source._changed.set()

    def _send(self, frame: av.VideoFrame, pts: int) -> av.VideoFrame:
        frame.pts = pts
        frame.time_base = VIDEO_TIME_BASE
        self._last_pts = pts
        self._last_sent_at = time.monotonic()
        return frame

    async def recv(self) -> av.VideoFrame:
        if self.readyState != "live":
            raise MediaStreamError
        source = self._sender.source
        while True:
            if source._closed:
                raise MediaStreamError
            now = time.monotonic()
            latest = source._latest
            if latest is None:
                if self._repeat or now >= self._idle_due:
                    self._repeat = False
                    self._idle_due = now + IDLE_FRAME_INTERVAL_S
                    # capture_frame's default clock, so the first captured frame follows on.
                    return self._send(source._idle_frame(), int(now * 1_000_000) * 90_000 // 1_000_000)
                await source._wait(self._idle_due - now)
                continue
            if source._serial > self._serial:
                self._serial = source._serial
                self._repeat = False
                self._sender.frames_sent += 1
                frame, stamp = latest
                return self._send(source._to_av(frame), stamp * 90_000 // 1_000_000)
            if self._repeat and self._last_pts is not None:
                # The same picture, stamped on from the last one by the time since (frame_cadence_adapter.cc
                # ProcessRepeatedFrameOnDelayedCadence), so the next captured frame still follows on.
                self._repeat = False
                elapsed = int((now - self._last_sent_at) * 90_000)
                return self._send(source._to_av(latest[0]), self._last_pts + max(1, elapsed))
            await source._wait(None)


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
        self.keyframe_requests = 0

    def create_track(self) -> _SenderTrack:
        return _SenderTrack(self)

    def stats(self) -> RelayVideoSenderStats:
        return RelayVideoSenderStats(
            frames_captured=self.source._frames_captured - self._captured_at_publish,
            frames_sent=self.frames_sent,
            codec=self.codec,
            keyframe_requests=self.keyframe_requests,
        )


class _KeyframeRequests:
    """Stands in for an aiortc sender's ``_send_keyframe``: the encoder's next frame is a keyframe, as before,
    and the published camera sends its latest frame again at once (`KEYFRAME_REPEAT_AFTER_S`).

    aiortc calls ``_send_keyframe`` for every PLI and FIR (rtcrtpsender.py ``_handle_rtcp_packet``) and
    only sets a flag the next encode reads (``_next_encoded_frame``).
    """

    def __init__(self, sender: Any, force_keyframe: Callable[[], None]) -> None:
        self._sender = sender
        self._force_keyframe = force_keyframe

    def __call__(self) -> None:
        self._force_keyframe()
        track = getattr(self._sender, "track", None)
        if isinstance(track, _SenderTrack):
            track.request_keyframe()


def serve_keyframe_requests(sender: Any) -> None:
    """Route an aiortc video sender's keyframe requests through `_KeyframeRequests`, once."""
    force_keyframe = getattr(sender, "_send_keyframe", None)
    if force_keyframe is None or isinstance(force_keyframe, _KeyframeRequests):
        return
    sender._send_keyframe = _KeyframeRequests(sender, force_keyframe)


def request_keyframe(sender: Any) -> None:
    """Ask a video sender for a keyframe now, as a PLI from the SFU would."""
    force_keyframe = getattr(sender, "_send_keyframe", None)
    if force_keyframe is not None:
        force_keyframe()


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
