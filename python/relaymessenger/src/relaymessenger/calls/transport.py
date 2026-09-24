"""Provider-neutral Python WebRTC bridge for Relay Call rooms.

Python twin of `packages/livekit/src/transport.ts` (`RelayCallTransport`),
on aiortc. The class owns media negotiation with Cloudflare's Realtime SFU
through Relay's public call room; adapters exchange PCM16 frames and video
frames and hear call lifecycle events. When an SFU session never connects or
dies, the transport builds a new peer connection on a new session
(PROTOCOL.md section 4); the audio source, the published camera and the
``audio`` events carry on across the swap.
"""

from __future__ import annotations

import asyncio
import inspect
import logging
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Literal, Optional, Union

import numpy as np
from aiortc import RTCSessionDescription
from ._audio import RelayAudioSink, RelayAudioSource, monotonic_ms
from ._audio_format import INBOUND_SAMPLE_RATES, Int16Array
from ._engine import (
    PeerConfig,
    RelayIceServer,
    add_bundle_candidates,
    create_peer_connection,
    media_codec,
    normalize_ice_servers,
    order_for_aiortc,
    parse_candidate,
    prefer_h264,
)
from ._events import EventEmitter
from .room import DEFAULT_BASE_URL, CallRoom, CallRoomCloseEvent, CallRoomError
from .video import (
    LocalVideoTrack,
    RelayVideoReceiverStats,
    RelayVideoSenderStats,
    RemoteVideoTrack,
    TrackPublishOptions,
    _VideoSender,
    request_keyframe,
    request_keyframes,
    serve_keyframe_requests,
)

logger = logging.getLogger("relaymessenger.calls")

#: Restart rule, copied from PartyTracks and Cloudflare (PROTOCOL.md section 4):
#: not ``connected`` 5 s after the SFU answer (Cloudflare's echo example waits
#: 5000 ms), ``failed``, or ``disconnected`` for 7 s (PartyTracks.ts
#: ``timeoutSeconds = 7``). Backoff 250 ms x1.1 per attempt, capped at 10 s
#: (PartyTracks ``retryWithBackoff``, rxjs-helpers.ts defaults).
RESTART_CONNECT_TIMEOUT_MS = 5_000
RESTART_DISCONNECTED_MS = 7_000
RESTART_INITIAL_DELAY_MS = 250
RESTART_BACKOFF_FACTOR = 1.1
RESTART_MAX_DELAY_MS = 10_000

#: Cloudflare Realtime's echo example builds its peer with exactly this list
#: (cloudflare/realtime-examples echo/index.html `createPeerConnection`).
DEFAULT_ICE_SERVERS = [RelayIceServer(urls="stun:stun.cloudflare.com:3478")]

DEFAULT_ICE_GATHERING_TIMEOUT_MS = 10_000
AUDIO_SLICE_MS = 10
STALL_CHECK_MS = 500
STALL_AFTER_MS = 2_000
ACTIVE_CALL_STATUSES = frozenset({"ringing", "in-progress"})

RelayCallRestartReason = Literal["timeout", "failed", "disconnected", "error"]
TransportEvent = Literal[
    "audio",
    "connected",
    "restarted",
    "room_state",
    "remote_video",
    "track_subscribed",
    "track_unsubscribed",
    "peer_audio",
    "ended",
    "error",
    "close",
]
#: Returns the ICE servers for one peer connection; called before the first
#: peer and again before every restart, so short-lived TURN credentials can be
#: minted per attempt (PartyTracks: a reconnect "will trigger new sessionId, new
#: ice server credentials and a new peerConnection"). The argument is the
#: number of restarts so far (0 for the first peer).
RelayIceServersProvider = Callable[[int], Union[list[Any], Awaitable[list[Any]]]]


def restart_delay_ms(attempt: int) -> float:
    """Backoff before restart number ``attempt`` (1-based) since the last session that connected."""
    return min(RESTART_INITIAL_DELAY_MS * RESTART_BACKOFF_FACTOR ** (attempt - 1), RESTART_MAX_DELAY_MS)


class RelayCallTransportError(Exception):
    def __init__(self, message: str, code: Optional[str] = None) -> None:
        super().__init__(message)
        self.code = code


@dataclass
class RelayAudioFrame:
    #: Interleaved signed PCM16 samples.
    samples: Int16Array
    sample_rate: int
    channel_count: int


@dataclass(frozen=True)
class RelayInboundAudioFormat:
    """PCM format of the ``audio`` events. Defaults to 48 kHz stereo."""

    sample_rate: int = 48_000
    channel_count: int = 2


@dataclass
class RelayCallRestartEvent:
    reason: RelayCallRestartReason
    #: ``diagnostics().summary`` of the session being replaced, taken as it was given up.
    summary: str
    #: Restarts since ``connect()``, this one included.
    restarts: int
    #: Backoff waited before the new peer was built.
    delay_ms: float


@dataclass
class RelayCallInboundDiagnostics:
    #: Opus packets received on the subscribed track (aiortc hands one decoded frame per packet).
    rtp_packets: int = 0
    #: PCM frames handed to the ``audio`` listeners (after resampling).
    frames: int = 0
    #: ms since ``connect()`` for the first and last packet.
    first_packet_at_ms: Optional[float] = None
    last_packet_at_ms: Optional[float] = None
    #: Packets received in the 5 s before ``diagnostics()`` was called.
    recent_rtp_packets: int = 0
    #: Packets per second from the first to the last packet.
    packets_per_second: Optional[float] = None


@dataclass
class RelayCallOutboundDiagnostics:
    #: 10 ms PCM slices accepted from the caller.
    frames: int = 0
    opus_packets: int = 0
    #: RTP packets carrying the caller's audio.
    rtp_packets: int = 0
    #: RTP packets carrying Opus silence, written while nothing was queued.
    silence_packets: int = 0
    first_packet_at_ms: Optional[float] = None
    last_packet_at_ms: Optional[float] = None
    recent_rtp_packets: int = 0
    #: Encoded packets waiting for the 20 ms pacer.
    queued: int = 0
    pacer_alive: bool = False
    #: Times the pacer fell more than 200 ms behind and restarted its clock.
    pacer_late_restarts: int = 0
    #: Packets of either kind per second from the first to the last packet.
    packets_per_second: Optional[float] = None
    #: ms since ``connect()`` for the first packet carrying the caller's audio.
    first_audio_at_ms: Optional[float] = None
    #: The caller's audio is queued and held until the other participant receives it (PROTOCOL.md section 6b).
    held: bool = False


@dataclass
class RelayCallRoomDiagnostics:
    room_states: int = 0
    #: Subscription (pull) offers received from the room.
    offers: int = 0
    ended_reason: Optional[str] = None
    errors: list[str] = field(default_factory=list)
    #: Room sockets opened (1 without a reconnect).
    opens: int = 0


@dataclass
class RelayCallTransition:
    #: ``signaling`` states are ``room open``, ``offer``, ``restart offer``,
    #: ``answer`` and ``pull <track>``; the others are the peer's own states.
    kind: Literal["signaling", "gathering", "ice", "connection"]
    state: str
    at_ms: float


@dataclass
class RelayCallDiagnostics:
    """ICE facts, packet counts, room frames and restarts for one call, with a one-line summary.

    There is no winning candidate pair: aiortc's public API does not expose it
    (its `getStats()` has no ``candidate-pair`` entry).
    """

    local: dict[str, int]
    remote: list[tuple[str, int]]
    transitions: list[RelayCallTransition]
    connected: bool
    inbound: RelayCallInboundDiagnostics
    outbound: RelayCallOutboundDiagnostics
    room: RelayCallRoomDiagnostics
    restarts: int
    summary: str = ""


@dataclass
class RelayCallVideoStats:
    outbound: Optional[RelayVideoSenderStats]
    inbound: Optional[RelayVideoReceiverStats]


def _seconds(ms: float) -> str:
    return f"{ms / 1000:.1f}s"


def _span(first: Optional[float], last: Optional[float]) -> str:
    if first is None or last is None:
        return "no packets"
    return f"first {_seconds(first)} last {_seconds(last)}"


def _rate(packets: int, first: Optional[float], last: Optional[float]) -> Optional[float]:
    if first is None or last is None or last <= first or packets < 2:
        return None
    return round((packets - 1) / ((last - first) / 1000), 2)


def summarize(d: RelayCallDiagnostics) -> str:
    local = d.local
    local_part = f"local: host {local['host']}, srflx {local['srflx']}, relay {local['relay']}"
    if local["other"]:
        local_part += f", other {local['other']}"
    remote_part = "remote: " + (", ".join(f"{t} {p}" for t, p in d.remote) if d.remote else "none")
    states: list[str] = []
    last_gathering = "new"
    for t in d.transitions:
        if t.kind == "gathering":
            states.append(f"{last_gathering}→{t.state} {_seconds(t.at_ms)}")
            last_gathering = t.state
        elif t.kind == "ice":
            states.append(f"ice {t.state} {_seconds(t.at_ms)}")
        else:
            states.append(f"{t.state} {_seconds(t.at_ms)}")
    if not d.connected:
        states.append("no connected")
    i, o, r = d.inbound, d.outbound, d.room
    inbound = (
        f"in: {i.rtp_packets} rtp, {i.frames} frames, {_span(i.first_packet_at_ms, i.last_packet_at_ms)}, "
        f"{i.recent_rtp_packets}/5s, {i.packets_per_second if i.packets_per_second is not None else '-'}/s"
    )
    outbound = (
        f"out: {o.frames} frames, {o.opus_packets} opus, {o.rtp_packets} rtp, silence {o.silence_packets}, "
        f"{_span(o.first_packet_at_ms, o.last_packet_at_ms)}, {o.recent_rtp_packets}/5s, "
        f"{o.packets_per_second if o.packets_per_second is not None else '-'}/s, queue {o.queued}, "
        f"pacer {'alive' if o.pacer_alive else 'idle'}"
        + (f", pacer late {o.pacer_late_restarts}" if o.pacer_late_restarts else "")
        + (", held" if o.held else "")
    )
    room_parts = [f"{r.room_states} roomState", f"{r.offers} offer", f"{r.opens} open"]
    if r.ended_reason is not None:
        room_parts.append(f"ended {r.ended_reason}")
    if r.errors:
        room_parts.append("error " + ", ".join(repr(e) for e in r.errors))
    text = (
        f"{local_part}; {remote_part}; states: {', '.join(states)}; {inbound}; {outbound}; "
        f"room: {', '.join(room_parts)}"
    )
    if d.restarts:
        text += f"; restarts {d.restarts}"
    return text


PeerFactory = Callable[[PeerConfig], Any]


class RelayCallTransport(EventEmitter[TransportEvent]):
    """Join a Relay Call room as a WebRTC participant and exchange PCM16 audio and video.

    Events: ``audio`` (`RelayAudioFrame`), ``connected``, ``restarted``
    (`RelayCallRestartEvent`), ``room_state`` (frame dict), ``remote_video``
    (bool: the other participant's camera is sending), ``track_subscribed`` /
    ``track_unsubscribed`` (`RemoteVideoTrack`), ``peer_audio``, ``ended``
    (frame dict), ``error`` (exception) and ``close`` (`CallRoomCloseEvent`).
    """

    def __init__(
        self,
        *,
        api_key: Optional[str] = None,
        call_id: str,
        base_url: str = DEFAULT_BASE_URL,
        room: Optional[CallRoom] = None,
        ice_servers: Union[list[Any], RelayIceServersProvider, None] = None,
        session_connect_timeout_ms: float = RESTART_CONNECT_TIMEOUT_MS,
        inbound_audio: RelayInboundAudioFormat = RelayInboundAudioFormat(),
        audio_out_auto_silence: bool = True,
        on_warning: Optional[Callable[[str], None]] = None,
        _peer_factory: Optional[PeerFactory] = None,
        _ice_gathering_timeout_ms: float = DEFAULT_ICE_GATHERING_TIMEOUT_MS,
        _restart_disconnected_ms: float = RESTART_DISCONNECTED_MS,
    ) -> None:
        super().__init__()
        if not call_id.strip():
            raise ValueError("call_id is required.")
        if room is None:
            if not api_key:
                raise ValueError("api_key is required.")
            room = CallRoom(call_id, api_key=api_key, base_url=base_url)
        if inbound_audio.sample_rate not in INBOUND_SAMPLE_RATES:
            raise ValueError("inbound_audio.sample_rate must be 8000, 12000, 16000, 24000 or 48000.")
        if inbound_audio.channel_count not in (1, 2):
            raise ValueError("inbound_audio.channel_count must be 1 or 2.")
        if not session_connect_timeout_ms > 0:
            raise ValueError("session_connect_timeout_ms must be greater than zero.")
        self.call_id = call_id
        self.room = room
        self._inbound = inbound_audio
        # Pipecat's ``TransportParams.audio_out_auto_silence``: False waits for the
        # next audio instead of sending silence once audio may play (`RelayAudioSource`).
        self._audio_out_auto_silence = audio_out_auto_silence
        # ``None``: the application passed none, so the room's servers are used.
        self._ice_servers: Union[list[RelayIceServer], RelayIceServersProvider, None] = (
            ice_servers if ice_servers is None or callable(ice_servers) else normalize_ice_servers(ice_servers)
        )
        # Set by the room's first ``iceServers`` or ``roomState``, or by the room or transport ending.
        self._room_ice_settled = asyncio.Event()
        self._session_connect_timeout_ms = session_connect_timeout_ms
        self._ice_gathering_timeout_ms = _ice_gathering_timeout_ms
        self._restart_disconnected_ms = _restart_disconnected_ms
        self._on_warning = on_warning or (lambda _message: None)
        self._peer_factory: PeerFactory = _peer_factory or create_peer_connection
        self._connect_started_at = 0.0
        self._inbound_frames = 0
        self._outbound_frames = 0
        self._room_states = 0
        self._room_offers = 0
        self._room_opens = 0
        self._ended_reason: Optional[str] = None
        self._room_errors: list[str] = []
        self._retired_sink_stats: Optional[tuple[int, Optional[float], Optional[float]]] = None
        self._final_inbound: Optional[RelayCallInboundDiagnostics] = None
        self._stall_task: Optional[asyncio.Task[None]] = None
        self._stall_since: Optional[float] = None
        self._stall_warned = False
        self._ice_local = {"host": 0, "srflx": 0, "relay": 0, "other": 0}
        self._ice_remote: list[tuple[str, int]] = []
        self._transitions: list[RelayCallTransition] = []
        self._source: Optional[RelayAudioSource] = None
        self._peer: Any = None
        self._peer_generation = 0
        self._peer_connected = False
        self._remote_sink: Optional[RelayAudioSink] = None
        self._publish_transceiver: Any = None
        self._publish_frame: Optional[dict[str, Any]] = None
        self._initial_answer_sdp: Optional[str] = None
        self._last_answer_sdp: Optional[str] = None
        self._negotiation_tail: Optional[asyncio.Future[Any]] = None
        self._restarts = 0
        self._failed_attempts = 0
        self._restart_pending = False
        self._wake_restart: Optional[asyncio.Event] = None
        self._connect_timer: Optional[asyncio.TimerHandle] = None
        self._disconnect_timer: Optional[asyncio.TimerHandle] = None
        self._call_status: Optional[str] = None
        self._remote_video = False
        self._person_connected = False
        # The person's latest roomState ``receiving`` contains ``audio`` (PROTOCOL.md section 6b).
        self._person_receiving_audio = False
        # The same for ``video``: the person has started receiving this peer's camera.
        self._person_receiving_video = False
        self._peer_audio_arrived = False
        self._peer_audio_ready = False
        self._peer_audio_waiters: set[asyncio.Future[None]] = set()
        self._ended = False
        self._audio_generation = 0
        self._playout_waiters: set[asyncio.Future[None]] = set()
        self._reported_connected = False
        self._ready: Optional[asyncio.Future[None]] = None
        self._keyframe_task: Optional[asyncio.Task[None]] = None
        self._handlers_attached = False
        self._closed = False
        self._muted = False
        self._video: Optional[_VideoSender] = None
        self._video_transceiver: Any = None
        self._remote_video_track: Optional[RemoteVideoTrack] = None
        self._remote_video_engine_track: Any = None
        self._add_track_pending = False
        self._deferred_offer: Optional[dict[str, Any]] = None
        self._background: set[asyncio.Task[Any]] = set()
        self._candidates_recorded_for: Any = None

    # ---- lifecycle ------------------------------------------------------------------

    async def connect(self) -> None:
        """Join the room, publish, and return on the first ``connected``.

        Dead SFU sessions are replaced as they are found (PROTOCOL.md section 4),
        with no overall deadline: this raises only when the Call ends, the room
        or transport closes, or the room reports an error. Cancelling it closes
        the transport; the Call itself is not ended.
        """
        if self._closed:
            raise RelayCallTransportError("Relay Call transport is closed.")
        try:
            await self._connect()
        except asyncio.CancelledError:
            self._reject_ready(RelayCallTransportError("Relay Call connect was aborted.", "aborted"))
            self.close()
            raise

    async def _connect(self) -> None:
        loop = asyncio.get_running_loop()
        if self._ready is None:
            self._ready = loop.create_future()
        self._attach_room_handlers()
        if self._source is None:
            self._connect_started_at = monotonic_ms()
        await self.room.connect()
        if self._source is not None:
            await asyncio.shield(self._ready)
            return
        self._record("signaling", "room open")
        # Application audio leaves only while the person receives it (PROTOCOL.md section 6b).
        self._source = RelayAudioSource(playing=lambda: self.subscribed, auto_silence=self._audio_out_auto_silence)
        if self._video is not None and self._video.enabled:
            # Published before connect(): the camera rides the first offer.
            self.room.user_update(muted=self._muted, video=True)
        try:
            await self._start_peer()
            await asyncio.shield(self._ready)
        except BaseException:
            self.close()
            raise

    async def reconnect(self) -> None:
        """Replace only the room signaling socket and replay the identical publication."""
        if self._closed:
            raise RelayCallTransportError("Relay Call transport is closed.")
        if self._publish_frame is None:
            raise RelayCallTransportError("Relay Call transport is not connected.")
        await self.room.reconnect()
        self.room.send(self._publish_frame)

    def end(self) -> None:
        """End the Relay Call for both participants."""
        self.room.end()

    def close(self) -> None:
        """Local cleanup: stop media and close the room socket. The Call is not ended."""
        if self._closed:
            return
        self._closed = True
        self._reject_ready(RelayCallTransportError("Relay Call transport closed before media connected."))
        self._reject_peer_audio(
            RelayCallTransportError("Relay Call transport closed before the person's audio arrived.")
        )
        self._audio_generation += 1
        self._shutdown_media()
        self._release_playout_waiters()
        self._room_ice_settled.set()
        self.room.close()

    async def aclose(self) -> None:
        self.close()
        tasks = [t for t in self._background if not t.done()]
        if tasks:
            await asyncio.wait(tasks, timeout=5)

    # ---- audio ----------------------------------------------------------------------

    async def write_audio(self, frame: RelayAudioFrame) -> None:
        """Feed interleaved PCM16 into Relay; returns once the 10 ms slices are queued.

        The pacer sends them at 50 packets a second, so adapters may push faster
        than real time (LiveKit's ``AudioSource.capture_frame`` shape);
        `wait_for_playout()` tells when they have left. Until the person is
        receiving this participant's audio (`subscribed`), the queue is held and
        silence goes out; it then plays from its start, nothing dropped
        (PROTOCOL.md section 6b). A restart holds it again until the new session
        is pulled. Once it plays, an empty queue sends silence, or, with
        ``audio_out_auto_silence=False``, waits for the next audio.
        """
        if self._closed:
            raise RelayCallTransportError("Relay Call transport is closed.")
        if self._source is None:
            raise RelayCallTransportError("Relay Call transport is not connected.")
        if not isinstance(frame.sample_rate, int) or frame.sample_rate <= 0 or frame.sample_rate % 100:
            raise ValueError("Relay audio sample_rate must be a positive multiple of 100.")
        if not isinstance(frame.channel_count, int) or frame.channel_count <= 0:
            raise ValueError("Relay audio channel_count must be a positive integer.")
        samples = np.asarray(frame.samples, dtype=np.int16).reshape(-1)
        if samples.size % frame.channel_count:
            raise ValueError("Relay audio samples must contain complete interleaved frames.")
        source = self._source
        slice_samples = frame.sample_rate * AUDIO_SLICE_MS // 1000 * frame.channel_count
        for offset in range(0, samples.size, slice_samples):
            chunk = samples[offset : offset + slice_samples]
            if chunk.size < slice_samples:
                padded = np.zeros(slice_samples, dtype=np.int16)
                padded[: chunk.size] = chunk
                chunk = padded
            source.on_data(chunk, frame.sample_rate, frame.channel_count)
            self._outbound_frames += 1

    def queued_audio_ms(self) -> float:
        """Milliseconds of audio accepted by `write_audio` but not yet sent."""
        return self._source.queued_ms() if self._source is not None else 0

    async def wait_for_playout(self) -> None:
        """Return when every accepted slice has been sent; early on `clear_audio()` or `close()`."""
        source = self._source
        if source is None or self._closed or self.queued_audio_ms() == 0:
            return
        release: asyncio.Future[None] = asyncio.get_running_loop().create_future()
        self._playout_waiters.add(release)
        drain = asyncio.ensure_future(source.wait_for_drain())
        try:
            await asyncio.wait([drain, release], return_when=asyncio.FIRST_COMPLETED)
        finally:
            self._playout_waiters.discard(release)
            drain.cancel()

    def clear_audio(self) -> None:
        """Drop outgoing PCM that has not been sent and release `wait_for_playout()` callers."""
        self._audio_generation += 1
        if self._source is not None:
            self._source.clear()
        self._release_playout_waiters()

    async def wait_for_peer_audio(self, timeout_ms: float) -> None:
        """Return once ``peer_audio`` has fired; raise after ``timeout_ms`` or when the Call ends first."""
        if not timeout_ms > 0:
            raise ValueError("wait_for_peer_audio timeout_ms must be greater than zero.")
        if self._peer_audio_ready:
            return
        if self._closed or self._ended:
            raise RelayCallTransportError("Relay Call ended before the person's audio arrived.")
        waiter: asyncio.Future[None] = asyncio.get_running_loop().create_future()
        self._peer_audio_waiters.add(waiter)
        try:
            await asyncio.wait_for(asyncio.shield(waiter), timeout_ms / 1000)
        except asyncio.TimeoutError:
            raise RelayCallTransportError(
                f"Timed out waiting for the person's audio ({self.diagnostics().summary})"
            ) from None
        finally:
            self._peer_audio_waiters.discard(waiter)

    @property
    def subscribed(self) -> bool:
        """True while the person is receiving this transport's audio (PROTOCOL.md section 6b).

        A roomState that arrived after this peer's publish answer was applied
        lists ``audio`` in the person's ``receiving``. False again from a
        restart until the new session is pulled. `write_audio` holds audio
        while this is false (LiveKit's room output waits for
        ``publication.wait_for_subscription()`` the same way).
        """
        return self._person_receiving_audio and self._initial_answer_sdp is not None and not self._restart_pending

    def set_muted(self, muted: bool) -> None:
        self._muted = muted
        self.room.user_update(muted=muted)

    # ---- video ----------------------------------------------------------------------

    async def publish_track(self, track: LocalVideoTrack, options: Optional[TrackPublishOptions] = None) -> None:
        """Publish the camera (LiveKit ``LocalParticipant.publish_track``).

        Called before `connect()`, the camera is published with the audio in
        the first offer, one ``tracks/new`` for both, as Cloudflare's echo
        example pushes its audio and video (realtime-examples echo/index.html).
        Called after ``connected``, the first call adds a ``video`` track to the
        SFU session with an add-track offer, then announces ``userUpdate {
        video: true }``; later calls, after `unpublish_track`, only resume
        sending and announce it again (PROTOCOL.md sections 1-2).
        """
        if self._closed or self._ended:
            raise RelayCallTransportError("Relay Call transport is closed.")
        if self._source is None and self._video is None:
            self._video = _VideoSender(track, options or TrackPublishOptions())
            return
        if self._source is None or not self._reported_connected:
            raise RelayCallTransportError("Relay Call transport is not connected.")
        if self._video is not None:
            if self._video.track is not track:
                raise RelayCallTransportError("A Relay call publishes one video track.")
            self._video.enabled = True
            if self._video_transceiver is not None:
                self._video_transceiver.sender.replaceTrack(self._video.create_track())
            self.room.user_update(muted=self._muted, video=True)
            return
        self._video = _VideoSender(track, options or TrackPublishOptions())

        async def add() -> None:
            # No peer: a restart is pending, and the next peer publishes video with audio.
            peer = self._peer
            if peer is None:
                return
            self._add_video_transceiver(peer)
            await self._publish_local_audio(peer, restart=False)
            self._add_track_pending = self._peer is peer

        await self._negotiate(add)
        self.room.user_update(muted=self._muted, video=True)

    async def unpublish_track(self, track: LocalVideoTrack) -> None:
        """Stop sending the camera and announce ``userUpdate { video: false }``; the track stays negotiated."""
        if self._video is None or self._video.track is not track:
            return
        self._video.enabled = False
        if self._video_transceiver is not None:
            # W3C replaceTrack(null): the sender stops sending, nothing is renegotiated.
            self._video_transceiver.sender.replaceTrack(None)
        if not self._closed and not self._ended:
            self.room.user_update(muted=self._muted, video=False)

    @property
    def remote_video_track(self) -> Optional[RemoteVideoTrack]:
        """The other participant's video track, once it has reached this peer."""
        return self._remote_video_track

    def video_stats(self) -> RelayCallVideoStats:
        return RelayCallVideoStats(
            outbound=self._video.stats() if self._video is not None else None,
            inbound=self._remote_video_track.stats() if self._remote_video_track is not None else None,
        )

    def _add_video_transceiver(self, peer: Any) -> None:
        video = self._video
        if video is None:
            return
        transceiver = peer.addTransceiver("video", direction="sendonly")
        prefer_h264(transceiver)
        serve_keyframe_requests(transceiver.sender)
        if video.enabled:
            transceiver.sender.replaceTrack(video.create_track())
        self._video_transceiver = transceiver

    # ---- diagnostics ----------------------------------------------------------------

    def diagnostics(self) -> RelayCallDiagnostics:
        """ICE candidates, state transitions, packet counts both ways, room frames and restarts, with a summary."""
        d = RelayCallDiagnostics(
            local=dict(self._ice_local),
            remote=list(self._ice_remote),
            transitions=list(self._transitions),
            connected=self._peer_connected,
            inbound=self._inbound_diagnostics(),
            outbound=self._outbound_diagnostics(),
            room=RelayCallRoomDiagnostics(
                room_states=self._room_states,
                offers=self._room_offers,
                ended_reason=self._ended_reason,
                errors=list(self._room_errors),
                opens=self._room_opens,
            ),
            restarts=self._restarts,
        )
        d.summary = summarize(d)
        return d

    def _since_connect(self, at: Optional[float]) -> Optional[float]:
        return None if at is None else round(at - self._connect_started_at, 1)

    def _inbound_diagnostics(self) -> RelayCallInboundDiagnostics:
        if self._final_inbound is not None:
            return self._final_inbound
        count, first, last, recent = 0, None, None, 0
        if self._retired_sink_stats is not None:
            count, first, last = self._retired_sink_stats
        if self._remote_sink is not None:
            s = self._remote_sink.stats()
            count += s.rtp_packets
            first = first if first is not None else s.first_rtp_at
            last = s.last_rtp_at if s.last_rtp_at is not None else last
            recent = s.recent_rtp_packets
        first_ms, last_ms = self._since_connect(first), self._since_connect(last)
        return RelayCallInboundDiagnostics(
            rtp_packets=count,
            frames=self._inbound_frames,
            first_packet_at_ms=first_ms,
            last_packet_at_ms=last_ms,
            recent_rtp_packets=recent,
            packets_per_second=_rate(count, first_ms, last_ms),
        )

    def _outbound_diagnostics(self) -> RelayCallOutboundDiagnostics:
        if self._source is None:
            return RelayCallOutboundDiagnostics(frames=self._outbound_frames)
        s = self._source.stats()
        first_ms, last_ms = self._since_connect(s.first_rtp_at), self._since_connect(s.last_rtp_at)
        return RelayCallOutboundDiagnostics(
            frames=self._outbound_frames,
            opus_packets=s.opus_packets,
            rtp_packets=s.rtp_packets,
            silence_packets=s.silence_packets,
            first_packet_at_ms=first_ms,
            last_packet_at_ms=last_ms,
            recent_rtp_packets=s.recent_rtp_packets,
            queued=s.queued,
            pacer_alive=s.pacer_alive,
            pacer_late_restarts=s.pacer_late_restarts,
            packets_per_second=_rate(s.rtp_packets + s.silence_packets, first_ms, last_ms),
            first_audio_at_ms=self._since_connect(s.first_audio_at),
            held=s.held,
        )

    async def _stall_guard(self) -> None:
        """Warn once when audio is queued but no packet has left for 2 s while connected; restart nothing."""
        while not self._stall_warned and not self._closed:
            await asyncio.sleep(STALL_CHECK_MS / 1000)
            source = self._source
            if source is None or not self._reported_connected:
                continue
            stats = source.stats()
            if stats.queued == 0:
                self._stall_since = None
                continue
            now = monotonic_ms()
            if self._stall_since is None:
                self._stall_since = now
            idle_since = max(stats.last_rtp_at or self._stall_since, self._stall_since)
            if now - idle_since < STALL_AFTER_MS:
                continue
            self._stall_warned = True
            self._on_warning(f"Relay outbound audio stalled ({self.diagnostics().summary})")

    # ---- negotiation ----------------------------------------------------------------

    def _spawn(self, awaitable: Awaitable[Any]) -> "asyncio.Task[Any]":
        task = asyncio.ensure_future(awaitable)
        self._background.add(task)
        task.add_done_callback(self._background.discard)
        return task

    def _negotiate(self, work: Callable[[], Awaitable[Any]]) -> "asyncio.Future[Any]":
        """Run ``work`` after every earlier negotiation step; the caller gets its result or error."""
        previous = self._negotiation_tail

        async def run() -> Any:
            if previous is not None:
                try:
                    await previous
                except BaseException:  # noqa: BLE001 - an earlier step's failure is its own caller's
                    pass
            return await work()

        task = self._spawn(run())
        self._negotiation_tail = task
        return task

    def _queue_negotiation(self, work: Callable[[], Awaitable[Any]]) -> None:
        task = self._negotiate(work)

        def done(t: "asyncio.Future[Any]") -> None:
            if t.cancelled():
                return
            error = t.exception()
            if error is not None:
                self._reject_ready(error)
                self.emit("error", error)

        task.add_done_callback(done)

    async def _start_peer(self) -> None:
        """Build a peer around the call's audio source and publish; later peers are restarts."""
        source = self._source
        if source is None:
            raise RelayCallTransportError("Relay Call transport is not connected.")
        restarts = self._restarts
        self._peer_generation += 1
        generation = self._peer_generation
        if self._ice_servers is None:
            servers = await self._room_ice_servers()
        elif callable(self._ice_servers):
            result = self._ice_servers(restarts)
            servers = normalize_ice_servers(await result if inspect.isawaitable(result) else result)
        else:
            servers = normalize_ice_servers(self._ice_servers)
        if self._closed or self._ended or generation != self._peer_generation:
            return
        peer = self._peer_factory(PeerConfig(ice_servers=servers))
        self._peer = peer
        self._peer_connected = False
        self._initial_answer_sdp = None
        self._publish_transceiver = peer.addTransceiver(source.create_track(), direction="sendonly")
        self._video_transceiver = None
        self._add_video_transceiver(peer)
        self._observe(peer)
        await self._publish_local_audio(peer, restart=restarts > 0)

    async def _room_ice_servers(self) -> list[RelayIceServer]:
        """The room's latest servers, ordered for aiortc (PROTOCOL.md section 6).

        Relay sends ``iceServers`` after it accepts ``join`` and before the first
        ``roomState``, so a ``roomState`` with none before it means a room that
        sends none: Cloudflare's STUN server is used. Otherwise waits for
        whichever comes first, or for the room or transport to end.
        """

        def settled() -> Optional[list[RelayIceServer]]:
            if self.room.ice_servers is not None:
                return order_for_aiortc(normalize_ice_servers(self.room.ice_servers))
            if self.room.state is not None or self._closed or self._ended:
                return normalize_ice_servers(DEFAULT_ICE_SERVERS)
            return None

        now = settled()
        if now is not None:
            return now
        await self._room_ice_settled.wait()
        return settled() or normalize_ice_servers(DEFAULT_ICE_SERVERS)

    def _observe(self, peer: Any) -> None:
        def on_connection_state() -> None:
            if self._peer is not peer:
                return
            self._record("connection", peer.connectionState)
            self._connection_state_changed(peer)

        def on_ice_state() -> None:
            if self._peer is peer:
                self._record("ice", peer.iceConnectionState)

        def on_gathering_state() -> None:
            if self._peer is peer:
                self._record("gathering", peer.iceGatheringState)

        def on_track(track: Any) -> None:
            if self._peer is peer:
                self._remote_track(track)

        peer.on("connectionstatechange", on_connection_state)
        peer.on("iceconnectionstatechange", on_ice_state)
        peer.on("icegatheringstatechange", on_gathering_state)
        peer.on("track", on_track)

    async def _publish_local_audio(self, peer: Any, *, restart: bool) -> None:
        """Offer, and send it as soon as the local description is set (Cloudflare's echo example).

        aiortc gathers every candidate inside ``setLocalDescription``; the SFU is
        ICE-lite and learns this peer's address from its connectivity checks.
        """
        offer = await peer.createOffer()
        await asyncio.wait_for(peer.setLocalDescription(offer), self._ice_gathering_timeout_ms / 1000)
        if self._peer is not peer:
            return
        description = self._local_description(peer, "offer")
        if self._candidates_recorded_for is not peer:
            # Once per peer: an add-track offer repeats the same candidates.
            self._candidates_recorded_for = peer
            self._record_local_candidates(description["sdp"])
        mid = self._publish_transceiver.mid if self._publish_transceiver is not None else None
        if not mid:
            raise RelayCallTransportError("Relay audio publication has no WebRTC MID.")
        video_mid = self._video_transceiver.mid if self._video is not None and self._video_transceiver else None
        if self._video is not None and not video_mid:
            raise RelayCallTransportError("Relay video publication has no WebRTC MID.")
        tracks = [{"mid": mid, "name": "audio"}]
        if video_mid:
            tracks.append({"mid": video_mid, "name": "video"})
        frame: dict[str, Any] = {"type": "offer", "session_description": description, "tracks": tracks}
        if restart:
            frame["restart"] = True
        self._publish_frame = frame
        self.room.send(frame)
        self._record("signaling", "restart offer" if restart else "offer")

    def _attach_room_handlers(self) -> None:
        if self._handlers_attached:
            return
        self._handlers_attached = True
        room = self.room

        @room.on("open")
        def on_open() -> None:
            self._room_opens += 1

        @room.on("ice_servers")
        def on_ice_servers(_frame: dict[str, Any]) -> None:
            self._room_ice_settled.set()

        @room.on("answer")
        def on_answer(frame: dict[str, Any]) -> None:
            self._queue_negotiation(lambda: self._server_answer(frame))

        @room.on("offer")
        def on_offer(frame: dict[str, Any]) -> None:
            self._room_offers += 1
            self._queue_negotiation(lambda: self._server_offer(frame))

        @room.on("room_state")
        def on_room_state(frame: dict[str, Any]) -> None:
            self._room_ice_settled.set()
            self._room_states += 1
            self._call_status = frame["call"]["status"]
            # A Call has exactly one agent; the transport is that agent, so the
            # person is the other participant.
            person = next((p for p in frame["participants"] if p["kind"] == "user"), None)
            video = bool(person and person.get("video") is True)
            changed = video != self._remote_video
            self._remote_video = video
            self._person_connected = bool(person and person["connected"])
            # Counts only for this peer's session: a roomState from before its publish
            # answer (first connect or a restart) describes pulls of no live session.
            self._person_receiving_audio = (
                self._initial_answer_sdp is not None
                and not self._restart_pending
                and bool(person and "audio" in (person.get("receiving") or []))
            )
            receiving_video = (
                self._initial_answer_sdp is not None
                and not self._restart_pending
                and bool(person and "video" in (person.get("receiving") or []))
            )
            if receiving_video and not self._person_receiving_video and self._video_transceiver is not None:
                # The person now receives this camera: start them on a keyframe instead of waiting for
                # their PLI, as LiveKit's SFU asks a publisher for one when it adds a subscriber's down
                # track (livekit pkg/sfu/downtrack.go keyFrameRequester); Cloudflare's SFU does not.
                request_keyframe(self._video_transceiver.sender)
            self._person_receiving_video = receiving_video
            self.emit("room_state", frame)
            if changed:
                self.emit("remote_video", video)
            self._check_peer_audio()

        @room.on("error")
        def on_error(error: Union[dict[str, Any], BaseException]) -> None:
            self._room_ice_settled.set()
            if isinstance(error, BaseException):
                self._reject_ready(error)
                self.emit("error", error)
                return
            self._room_errors.append(error["message"])
            parsed = RelayCallTransportError(error["message"], error["code"])
            self._reject_ready(parsed)
            self.emit("error", parsed)

        @room.on("ended")
        def on_ended(frame: dict[str, Any]) -> None:
            self._ended = True
            self._room_ice_settled.set()
            self._ended_reason = frame["reason"]
            self._reject_ready(RelayCallTransportError(f"Relay Call ended before media connected ({frame['reason']})."))
            self._reject_peer_audio(
                RelayCallTransportError(f"Relay Call ended before the person's audio arrived ({frame['reason']}).")
            )
            self.clear_audio()
            self._shutdown_media()
            self.emit("ended", frame)

        @room.on("close")
        def on_close(event: CallRoomCloseEvent) -> None:
            self._room_ice_settled.set()
            if not self._reported_connected:
                self._reject_ready(RelayCallTransportError(f"Relay Call room closed before media connected ({event.code})."))
            self.emit("close", event)

    async def _server_answer(self, frame: dict[str, Any]) -> None:
        # No peer: the answer is for a session a restart already replaced.
        peer = self._peer
        if peer is None:
            return
        sdp = frame["session_description"]["sdp"]
        # Reconnecting the signaling socket replays the exact initial offer and
        # Relay returns its cached answer; applying it again in stable state is
        # invalid WebRTC signaling, so the replay is ignored.
        if peer.signalingState == "stable" and sdp in (self._initial_answer_sdp, self._last_answer_sdp):
            return
        initial = self._initial_answer_sdp is None
        if initial:
            self._record_remote_candidates(sdp)
        await peer.setRemoteDescription(RTCSessionDescription(sdp=sdp, type="answer"))
        if self._peer is not peer:
            return
        await add_bundle_candidates(peer, sdp)
        self._record("signaling", "answer")
        if self._initial_answer_sdp is None:
            self._initial_answer_sdp = sdp
        self._last_answer_sdp = sdp
        if self._video is not None and self._video_transceiver is not None:
            self._video.codec = media_codec(sdp, self._video_transceiver.mid) or self._video.codec
        if initial and not self._peer_connected:
            self._arm_connect_timer(peer)
        if self._add_track_pending:
            self._add_track_pending = False
            deferred, self._deferred_offer = self._deferred_offer, None
            if deferred is not None:
                await self._server_offer(deferred)

    async def _server_offer(self, frame: dict[str, Any]) -> None:
        peer = self._peer
        # A pull offer that crosses this participant's add-track offer is for the
        # live session: it is answered once the add-track answer is applied.
        if peer is not None and self._add_track_pending:
            self._deferred_offer = frame
            return
        # A pull offer that arrives while this participant's restart offer is
        # unanswered was sent for the replaced session: the room pulls again
        # after the new session connects.
        if peer is None or peer.signalingState == "have-local-offer":
            return
        sdp = frame["session_description"]["sdp"]
        self._record("signaling", f"pull {frame['track']}")
        await peer.setRemoteDescription(RTCSessionDescription(sdp=sdp, type="offer"))
        answer = await peer.createAnswer()
        await peer.setLocalDescription(answer)
        if self._peer is not peer:
            return
        self.room.send({"type": "answer", "session_description": self._local_description(peer, "answer")})
        if frame["track"] == "video" and self._remote_video_track is not None:
            # The codec this peer answered for the pulled video (its first payload type).
            local = peer.localDescription
            for transceiver in peer.getTransceivers():
                if transceiver.kind == "video" and transceiver.direction == "recvonly":
                    self._remote_video_track.codec = media_codec(local.sdp, transceiver.mid) or self._remote_video_track.codec

    # ---- connection state and restarts ----------------------------------------------

    def _connection_state_changed(self, peer: Any) -> None:
        state = peer.connectionState
        if state == "connected":
            self._clear_timer("connect")
            self._clear_timer("disconnect")
            if self._peer_connected:
                return
            self._peer_connected = True
            self._failed_attempts = 0
            if self._source is not None:
                self._source.start()
            try:
                # Sent for every new session: the room re-pulls a restarted
                # participant's tracks once it reports `connected` (PROTOCOL.md section 2).
                self.room.connected()
                if not self._reported_connected:
                    self._reported_connected = True
                    self._resolve_ready()
                    self._stall_task = self._spawn(self._stall_guard())
                    self.emit("connected")
            except CallRoomError as error:
                self._reject_ready(error)
                self.emit("error", error)
        elif state == "failed":
            self._request_restart("failed", peer)
        elif state == "disconnected":
            if self._disconnect_timer is not None:
                return

            def fire() -> None:
                self._disconnect_timer = None
                if peer.connectionState != "connected":
                    self._request_restart("disconnected", peer)

            self._disconnect_timer = asyncio.get_running_loop().call_later(self._restart_disconnected_ms / 1000, fire)

    def _arm_connect_timer(self, peer: Any) -> None:
        self._clear_timer("connect")

        def fire() -> None:
            self._connect_timer = None
            if not self._peer_connected:
                self._request_restart("timeout", peer)

        self._connect_timer = asyncio.get_running_loop().call_later(self._session_connect_timeout_ms / 1000, fire)

    def _clear_timer(self, which: Literal["connect", "disconnect"]) -> None:
        timer = self._connect_timer if which == "connect" else self._disconnect_timer
        if timer is not None:
            timer.cancel()
        if which == "connect":
            self._connect_timer = None
        else:
            self._disconnect_timer = None

    def _call_active(self) -> bool:
        if self._closed or self._ended:
            return False
        return self._call_status is None or self._call_status in ACTIVE_CALL_STATUSES

    def _request_restart(self, reason: RelayCallRestartReason, peer: Any) -> None:
        """Retire ``peer`` now, wait the backoff, then publish from a new peer on a new session."""
        if self._restart_pending or peer is not self._peer or not self._call_active():
            return
        summary = self.diagnostics().summary
        self._restart_pending = True
        # The person's pulls of the retired session are gone (PROTOCOL.md 6b).
        self._person_receiving_audio = False
        self._person_receiving_video = False
        self._restarts += 1
        self._failed_attempts += 1
        restarts = self._restarts
        delay_ms = restart_delay_ms(self._failed_attempts)
        self._retire_peer()

        async def restart() -> None:
            await self._restart_backoff(delay_ms)
            self._restart_pending = False
            if not self._call_active():
                return
            try:
                await self._start_peer()
            except Exception as error:  # noqa: BLE001 - a failed restart is retried
                if not self._call_active():
                    return
                self.emit(
                    "error",
                    RelayCallTransportError(f"Relay WebRTC restart {restarts} failed: {error}", "restart_failed"),
                )
                self._request_restart("error", self._peer)
                return
            if self._peer is not None:
                self.emit(
                    "restarted",
                    RelayCallRestartEvent(reason=reason, summary=summary, restarts=restarts, delay_ms=delay_ms),
                )

        self._queue_negotiation(restart)

    async def _restart_backoff(self, delay_ms: float) -> None:
        wake = asyncio.Event()
        self._wake_restart = wake
        try:
            await asyncio.wait_for(wake.wait(), delay_ms / 1000)
        except asyncio.TimeoutError:
            pass
        finally:
            if self._wake_restart is wake:
                self._wake_restart = None

    def _retire_peer(self) -> None:
        """Close the current peer and its sink; the audio source and the published camera stay."""
        self._clear_timer("connect")
        self._clear_timer("disconnect")
        peer, self._peer = self._peer, None
        self._peer_connected = False
        self._publish_transceiver = None
        self._video_transceiver = None
        self._initial_answer_sdp = None
        self._last_answer_sdp = None
        self._add_track_pending = False
        self._deferred_offer = None
        if self._remote_video_track is not None:
            self._remote_video_track._detach()
        self._remote_video_engine_track = None
        self._stop_keyframe_requests()
        self._retire_sink()
        if peer is not None:
            self._spawn(self._close_peer(peer))

    def _retire_sink(self) -> None:
        sink = self._remote_sink
        if sink is None:
            return
        stats = sink.stats()
        if self._retired_sink_stats is None:
            self._retired_sink_stats = (stats.rtp_packets, stats.first_rtp_at, stats.last_rtp_at)
        else:
            count, first, last = self._retired_sink_stats
            self._retired_sink_stats = (
                count + stats.rtp_packets,
                first if first is not None else stats.first_rtp_at,
                stats.last_rtp_at if stats.last_rtp_at is not None else last,
            )
        sink.stop()
        self._remote_sink = None

    @staticmethod
    async def _close_peer(peer: Any) -> None:
        try:
            await peer.close()
        except Exception:  # noqa: BLE001 - already closed
            pass

    def _remote_track(self, track: Any) -> None:
        if track.kind == "video":
            self._subscribe_remote_video(track)
            return
        if track.kind != "audio" or self._closed:
            return
        if self._remote_sink is not None and self._remote_sink.track is track:
            return
        self._retire_sink()
        generation = self._peer_generation

        def on_audio(samples: Int16Array, sample_rate: int, channel_count: int) -> None:
            if self._closed or generation != self._peer_generation:
                return
            self._inbound_frames += 1
            self.emit("audio", RelayAudioFrame(samples=samples, sample_rate=sample_rate, channel_count=channel_count))
            if not self._peer_audio_arrived:
                self._peer_audio_arrived = True
                self._check_peer_audio()

        self._remote_sink = RelayAudioSink(track, self._inbound.sample_rate, self._inbound.channel_count, on_audio)

    def _subscribe_remote_video(self, track: Any) -> None:
        if self._closed or self._remote_video_engine_track is track:
            return
        self._remote_video_engine_track = track
        existing = self._remote_video_track
        remote = existing or self._new_remote_video_track()
        self._remote_video_track = remote
        remote._attach(track)
        peer = self._peer
        transceiver = next(
            (t for t in peer.getTransceivers() if getattr(getattr(t, "receiver", None), "track", None) is track),
            None,
        )
        self._stop_keyframe_requests()
        if transceiver is not None:
            self._keyframe_task = self._spawn(request_keyframes(peer, transceiver, remote))
        if existing is None:
            self.emit("track_subscribed", remote)

    def _stop_keyframe_requests(self) -> None:
        if self._keyframe_task is not None:
            self._keyframe_task.cancel()
            self._keyframe_task = None

    def _new_remote_video_track(self) -> RemoteVideoTrack:
        """The call's one remote video track; an adapter overrides this to yield its framework's frames."""
        return RemoteVideoTrack()

    def _check_peer_audio(self) -> None:
        if self._peer_audio_ready or not self._peer_audio_arrived or not self._person_connected:
            return
        self._peer_audio_ready = True
        for waiter in list(self._peer_audio_waiters):
            if not waiter.done():
                waiter.set_result(None)
        self.emit("peer_audio")

    def _reject_peer_audio(self, error: BaseException) -> None:
        for waiter in list(self._peer_audio_waiters):
            if not waiter.done():
                waiter.set_exception(error)

    def _release_playout_waiters(self) -> None:
        for waiter in list(self._playout_waiters):
            if not waiter.done():
                waiter.set_result(None)

    def _record(self, kind: Literal["signaling", "gathering", "ice", "connection"], state: str) -> None:
        self._transitions.append(RelayCallTransition(kind=kind, state=state, at_ms=round(monotonic_ms() - self._connect_started_at, 1)))

    def _record_local_candidates(self, sdp: str) -> None:
        counts = {"host": 0, "srflx": 0, "relay": 0, "other": 0}
        # Every bundled section of an offer repeats the same candidates; each counts once.
        for line in dict.fromkeys(line for line in sdp.splitlines() if line.startswith("a=candidate:")):
            parsed = parse_candidate(line)
            kind = parsed[2] if parsed else "other"
            counts[kind if kind in counts else "other"] += 1
        for key, value in counts.items():
            self._ice_local[key] += value

    def _record_remote_candidates(self, sdp: str) -> None:
        for line in sdp.splitlines():
            if not line.startswith("a=candidate:"):
                continue
            parsed = parse_candidate(line)
            if parsed:
                self._ice_remote.append((parsed[0], parsed[1]))

    def _local_description(self, peer: Any, kind: str) -> dict[str, str]:
        local = peer.localDescription
        if local is None or local.type != kind or not local.sdp:
            raise RelayCallTransportError(f"Relay WebRTC did not produce a complete {kind} SDP.")
        return {"type": kind, "sdp": local.sdp}

    def _resolve_ready(self) -> None:
        if self._ready is not None and not self._ready.done():
            self._ready.set_result(None)

    def _reject_ready(self, error: BaseException) -> None:
        if self._ready is None:
            # Nothing has called connect(); a later connect() sees `_closed` or `_ended` itself.
            return
        if not self._ready.done():
            self._ready.set_exception(error)
            # Nobody may be awaiting; retrieving it keeps asyncio from logging it.
            self._ready.exception()

    def _shutdown_media(self) -> None:
        self._clear_timer("connect")
        self._clear_timer("disconnect")
        if self._wake_restart is not None:
            self._wake_restart.set()
        if self._stall_task is not None:
            self._stall_task.cancel()
        self._stop_keyframe_requests()
        if self._final_inbound is None and self._source is not None:
            self._final_inbound = self._inbound_diagnostics()
        if self._remote_sink is not None:
            self._remote_sink.stop()
            self._remote_sink = None
        if self._source is not None:
            self._source.stop()
        if self._video is not None:
            self._video.enabled = False
        remote = self._remote_video_track
        if remote is not None and not remote._ended:
            remote._end()
            self.emit("track_unsubscribed", remote)
        if self._peer is not None:
            self._spawn(self._close_peer(self._peer))
        self._peer = None
