"""Relay's call transport, with the other participant's camera as LiveKit frames.

The transport itself lives in `relaymessenger_calls.transport`, shared with
every framework adapter. This module keeps the import path and the names, and
makes `RelayCallTransport.remote_video_track` a LiveKit-shaped
`RemoteVideoTrack` whose `VideoStream` yields `rtc.VideoFrameEvent`.
"""

from __future__ import annotations

from typing import Optional, cast

from relaymessenger_calls import transport as _calls
from relaymessenger_calls.transport import (
    ACTIVE_CALL_STATUSES,
    AUDIO_SLICE_MS,
    DEFAULT_ICE_GATHERING_TIMEOUT_MS,
    DEFAULT_ICE_SERVERS,
    RESTART_BACKOFF_FACTOR,
    RESTART_CONNECT_TIMEOUT_MS,
    RESTART_DISCONNECTED_MS,
    RESTART_INITIAL_DELAY_MS,
    RESTART_MAX_DELAY_MS,
    STALL_AFTER_MS,
    STALL_CHECK_MS,
    PeerFactory,
    RelayAudioFrame,
    RelayCallDiagnostics,
    RelayCallInboundDiagnostics,
    RelayCallOutboundDiagnostics,
    RelayCallRestartEvent,
    RelayCallRestartReason,
    RelayCallRoomDiagnostics,
    RelayCallTransition,
    RelayCallTransportError,
    RelayCallVideoStats,
    RelayIceServersProvider,
    RelayInboundAudioFormat,
    TransportEvent,
    restart_delay_ms,
    summarize,
)

from .video import RemoteVideoTrack

__all__ = [
    "ACTIVE_CALL_STATUSES",
    "AUDIO_SLICE_MS",
    "DEFAULT_ICE_GATHERING_TIMEOUT_MS",
    "DEFAULT_ICE_SERVERS",
    "RESTART_BACKOFF_FACTOR",
    "RESTART_CONNECT_TIMEOUT_MS",
    "RESTART_DISCONNECTED_MS",
    "RESTART_INITIAL_DELAY_MS",
    "RESTART_MAX_DELAY_MS",
    "STALL_AFTER_MS",
    "STALL_CHECK_MS",
    "PeerFactory",
    "RelayAudioFrame",
    "RelayCallDiagnostics",
    "RelayCallInboundDiagnostics",
    "RelayCallOutboundDiagnostics",
    "RelayCallRestartEvent",
    "RelayCallRestartReason",
    "RelayCallRoomDiagnostics",
    "RelayCallTransition",
    "RelayCallTransport",
    "RelayCallTransportError",
    "RelayCallVideoStats",
    "RelayIceServersProvider",
    "RelayInboundAudioFormat",
    "TransportEvent",
    "restart_delay_ms",
    "summarize",
]


class RelayCallTransport(_calls.RelayCallTransport):
    """Join a Relay Call room as a WebRTC participant and exchange PCM16 audio and video.

    Events: ``audio`` (`RelayAudioFrame`), ``connected``, ``restarted``
    (`RelayCallRestartEvent`), ``room_state`` (frame dict), ``remote_video``
    (bool: the other participant's camera is sending), ``track_subscribed`` /
    ``track_unsubscribed`` (`RemoteVideoTrack`), ``peer_audio``, ``ended``
    (frame dict), ``error`` (exception) and ``close`` (`CallRoomCloseEvent`).
    """

    def _new_remote_video_track(self) -> RemoteVideoTrack:
        return RemoteVideoTrack()

    @property
    def remote_video_track(self) -> Optional[RemoteVideoTrack]:
        """The other participant's video track, once it has reached this peer."""
        return cast(Optional[RemoteVideoTrack], self._remote_video_track)
