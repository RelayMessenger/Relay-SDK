"""Video in LiveKit's Python shapes, carried by aiortc.

Twin of `packages/livekit/src/video.ts`. Frames are LiveKit's own
`livekit.rtc.VideoFrame` both ways, so a frame read here can go straight to an
`AgentSession` (Gemini Live samples it) and a frame an application already has
for LiveKit can be sent unchanged. The names copy `livekit.rtc`:
`VideoSource.capture_frame(frame, timestamp_us=, rotation=)`,
`LocalVideoTrack.create_video_track(name, source)`, `VideoStream(track)`
yielding `VideoFrameEvent`. The media itself lives in `relaymessenger.calls`;
this module converts at its two edges.
"""

from __future__ import annotations

from typing import Any, cast

import av
import numpy as np
from livekit import rtc
from relaymessenger.calls import video as _calls
from relaymessenger.calls.video import (
    VIDEO_TIME_BASE,
    LocalVideoTrack,
    RelayVideoReceiverStats,
    RelayVideoSenderStats,
    TrackPublishOptions,
    VideoEncoding,
    VideoStream,
    _SenderTrack,
    _VideoSender,
)

__all__ = [
    "VIDEO_TIME_BASE",
    "LocalVideoTrack",
    "RelayVideoReceiverStats",
    "RelayVideoSenderStats",
    "RemoteVideoTrack",
    "TrackPublishOptions",
    "VideoEncoding",
    "VideoSource",
    "VideoStream",
    "_SenderTrack",
    "_VideoSender",
    "to_av_frame",
    "to_rtc_frame",
]

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


class VideoSource(_calls.VideoSource):
    """The camera feed an application sends (LiveKit ``rtc.VideoSource``)."""

    def capture_frame(
        self,
        frame: rtc.VideoFrame,
        *,
        timestamp_us: int = 0,
        rotation: int = rtc.VideoRotation.VIDEO_ROTATION_0,
    ) -> None:
        """Queue ``frame`` for the next encode; a newer frame replaces one not yet taken, as a live camera does."""
        super().capture_frame(frame, timestamp_us=timestamp_us, rotation=rotation)

    def _to_av(self, frame: Any) -> av.VideoFrame:
        return to_av_frame(frame)


class RemoteVideoTrack(_calls.RemoteVideoTrack):
    """The other participant's camera (LiveKit ``rtc.RemoteVideoTrack``), one per call, kept across restarts."""

    def _event(self, frame: av.VideoFrame, timestamp_us: int) -> rtc.VideoFrameEvent:
        return rtc.VideoFrameEvent(
            frame=to_rtc_frame(frame),
            timestamp_us=timestamp_us,
            rotation=cast(Any, rtc.VideoRotation.VIDEO_ROTATION_0),
        )
