"""Relay Calls for Python: join a Relay Call as a WebRTC participant.

The framework-neutral core under ``relaymessenger-livekit`` and
``relaymessenger-pipecat``: the Call room client, the aiortc media peer, PCM16
audio both ways and video, over Relay's public API only. Needs the ``calls``
extra: ``pip install 'relaymessenger[calls]'``.
"""

# The media dependencies are the ``calls`` extra; the guard copies livekit-agents
# ``llm/mcp.py``, which names its extra when the optional package is missing.
try:
    import aiortc  # noqa: F401
    import av  # noqa: F401
    import numpy  # noqa: F401
except ImportError as e:
    raise ImportError(
        "relaymessenger.calls needs aiortc, av and numpy, which are not installed.\n"
        "To fix this, install the optional dependency: pip install 'relaymessenger[calls]'"
    ) from e

from ._engine import RelayIceServer
from ._events import EventEmitter
from .room import (
    DEFAULT_BASE_URL,
    CallRoom,
    CallRoomCloseEvent,
    CallRoomError,
    CallRoomReconnectingEvent,
    parse_call_room_server_frame,
)
from .transport import (
    RelayAudioFrame,
    RelayCallDiagnostics,
    RelayCallRestartEvent,
    RelayCallTransport,
    RelayCallTransportError,
    RelayCallVideoStats,
    RelayIceServersProvider,
    RelayInboundAudioFormat,
    restart_delay_ms,
)
from .video import (
    LocalVideoTrack,
    RelayVideoFrame,
    RemoteVideoTrack,
    TrackPublishOptions,
    VideoEncoding,
    VideoFrameEvent,
    VideoSource,
    VideoStream,
)

__all__ = [
    "DEFAULT_BASE_URL",
    "CallRoom",
    "CallRoomCloseEvent",
    "CallRoomError",
    "CallRoomReconnectingEvent",
    "EventEmitter",
    "LocalVideoTrack",
    "RelayAudioFrame",
    "RelayCallDiagnostics",
    "RelayCallRestartEvent",
    "RelayCallTransport",
    "RelayCallTransportError",
    "RelayCallVideoStats",
    "RelayIceServer",
    "RelayIceServersProvider",
    "RelayInboundAudioFormat",
    "RelayVideoFrame",
    "RemoteVideoTrack",
    "TrackPublishOptions",
    "VideoEncoding",
    "VideoFrameEvent",
    "VideoSource",
    "VideoStream",
    "parse_call_room_server_frame",
    "restart_delay_ms",
]
