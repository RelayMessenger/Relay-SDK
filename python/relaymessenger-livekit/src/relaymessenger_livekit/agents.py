"""LiveKit Agents audio and video IO backed by a Relay Call.

Python twin of `packages/livekit/src/livekit.ts`. Shapes copied from
livekit-agents 1.8 `voice/io.py` (`AudioInput`, `VideoInput`, `AudioOutput`)
and `voice/room_io/_input.py` / `_output.py` (`_ParticipantAudioInputStream`,
`_ParticipantVideoInputStream`, `_ParticipantAudioOutput`).
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, Optional, Union

from livekit import rtc
from livekit.agents.utils import aio
from livekit.agents.voice.io import AudioInput, AudioOutput, AudioOutputCapabilities, VideoInput

from .room import DEFAULT_BASE_URL, CallRoom
from .transport import (
    RESTART_CONNECT_TIMEOUT_MS,
    RelayAudioFrame,
    RelayCallDiagnostics,
    RelayCallTransport,
    RelayIceServersProvider,
    RelayInboundAudioFormat,
)
from .video import RemoteVideoTrack, VideoStream

logger = logging.getLogger("relaymessenger.livekit")

#: The format LiveKit's own room input hands an AgentSession: livekit-agents
#: voice/room_io/types.py `AudioInputOptions` (``sample_rate: int = 24000``,
#: ``num_channels: int = 1``), passed to the participant `rtc.AudioStream`.
LIVEKIT_ROOM_INPUT_AUDIO = RelayInboundAudioFormat(sample_rate=24_000, channel_count=1)
#: Opus's native rate; the session resamples TTS output to it.
DEFAULT_OUTPUT_SAMPLE_RATE = 48_000


class RelayAudioInput(AudioInput):
    """The remote Relay participant's audio as 24 kHz mono `rtc.AudioFrame`s.

    Like `_ParticipantAudioInputStream`, frames go through an unbounded
    `aio.Chan` and are dropped while the input is detached
    (room_io/_input.py `_forward_task`: ``if not self._attached: continue``).
    """

    def __init__(self, transport: RelayCallTransport) -> None:
        super().__init__(label="RelayCall")
        self._transport = transport
        self._data_ch: aio.Chan[rtc.AudioFrame] = aio.Chan()
        self._attached = True
        self._closed = False
        self._on_audio = transport.on("audio", self._forward)

    def _forward(self, frame: RelayAudioFrame) -> None:
        if self._closed or not self._attached:
            return
        samples_per_channel = frame.samples.size // frame.channel_count
        self._data_ch.send_nowait(
            rtc.AudioFrame(
                data=frame.samples.tobytes(),
                sample_rate=frame.sample_rate,
                num_channels=frame.channel_count,
                samples_per_channel=samples_per_channel,
            )
        )

    async def __anext__(self) -> rtc.AudioFrame:
        return await self._data_ch.__anext__()

    def on_attached(self) -> None:
        self._attached = True

    def on_detached(self) -> None:
        self._attached = False

    async def aclose(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._transport.off("audio", self._on_audio)
        self._data_ch.close()


class RelayVideoInput(VideoInput):
    """The remote Relay participant's camera as `rtc.VideoFrame`s (I420).

    Shape of `_ParticipantVideoInputStream`: frames of the subscribed track go
    through an `aio.Chan`, so `AgentSession`'s built-in video sampler and its
    forwarding to a realtime model (Gemini Live) read it unchanged
    (agent_session.py `_forward_video_task`). The stream follows the
    transport's one `RemoteVideoTrack`, which survives media restarts.
    """

    def __init__(self, transport: RelayCallTransport) -> None:
        super().__init__(label="RelayCall")
        self._transport = transport
        self._data_ch: aio.Chan[rtc.VideoFrame] = aio.Chan()
        self._attached = True
        self._closed = False
        self._stream: Optional[VideoStream] = None
        self._task: Optional[asyncio.Task[None]] = None
        self._on_track = transport.on("track_subscribed", self._subscribe)
        if transport.remote_video_track is not None:
            self._subscribe(transport.remote_video_track)

    def _subscribe(self, track: RemoteVideoTrack) -> None:
        if self._closed or self._stream is not None:
            return
        self._stream = VideoStream(track)
        self._task = asyncio.get_running_loop().create_task(self._forward(self._stream))

    async def _forward(self, stream: VideoStream) -> None:
        async for event in stream:
            if not self._attached:
                continue
            await self._data_ch.send(event.frame)

    async def __anext__(self) -> rtc.VideoFrame:
        return await self._data_ch.__anext__()

    def on_attached(self) -> None:
        self._attached = True

    def on_detached(self) -> None:
        self._attached = False

    async def aclose(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._transport.off("track_subscribed", self._on_track)
        if self._stream is not None:
            await self._stream.aclose()
        if self._task is not None:
            await aio.cancel_and_wait(self._task)
        self._data_ch.close()


class RelayAudioOutput(AudioOutput):
    """LiveKit Agents output that publishes TTS PCM to the Relay participant.

    Semantics of `_ParticipantAudioOutput` (room_io/_output.py):
    `capture_frame` hands the frame to the transport and returns without
    waiting for playout; `flush()` starts a playout task that reports
    `on_playback_finished` only once the transport has drained; `clear_buffer()`
    ends that task as ``interrupted=True`` with the position actually played.
    """

    def __init__(self, transport: RelayCallTransport, sample_rate: int = DEFAULT_OUTPUT_SAMPLE_RATE) -> None:
        super().__init__(
            label="RelayCall",
            capabilities=AudioOutputCapabilities(pause=False),
            next_in_chain=None,
            sample_rate=sample_rate,
        )
        self._transport = transport
        #: Seconds pushed to the transport in the open segment.
        self._pushed_duration = 0.0
        self._first_frame_emitted = False
        self._flush_task: Optional[asyncio.Task[None]] = None
        #: Set by `clear_buffer()`, with the milliseconds still queued at that moment
        #: (`_ParticipantAudioOutput._interrupted_event`).
        self._interrupted_event = asyncio.Event()
        self._interrupted_ms = 0.0
        self._closed = False

    async def capture_frame(self, frame: rtc.AudioFrame) -> None:
        if self._closed:
            raise RuntimeError("Relay LiveKit audio output is closed.")
        await super().capture_frame(frame)
        if self._flush_task is not None and not self._flush_task.done():
            logger.error("capture_frame called while flush is in progress")
            await self._flush_task
        if not self._first_frame_emitted:
            self._first_frame_emitted = True
            self.on_playback_started(created_at=time.time())
        self._pushed_duration += frame.duration
        # Returns once the slices are queued; the pacer paces the wire.
        await self._transport.write_audio(
            RelayAudioFrame(
                samples=_int16(frame),
                sample_rate=frame.sample_rate,
                channel_count=frame.num_channels,
            )
        )

    def flush(self) -> None:
        """Mark the segment complete; `on_playback_finished` fires once the transport has drained."""
        super().flush()
        if not self._pushed_duration:
            return
        if self._flush_task is not None and not self._flush_task.done():
            return
        self._flush_task = asyncio.get_running_loop().create_task(self._wait_for_playout())

    def clear_buffer(self) -> None:
        queued_ms = self._transport.queued_audio_ms()
        self._transport.clear_audio()
        if self._interrupted_event.is_set():
            return
        if self._pushed_duration == 0 and self._pending_playback_count == 0:
            return
        if self._flush_task is None or self._flush_task.done():
            self.flush()
        self._interrupted_ms = queued_ms
        self._interrupted_event.set()

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self.clear_buffer()

    async def _wait_for_playout(self) -> None:
        interrupted_event = self._interrupted_event
        playout = asyncio.ensure_future(self._transport.wait_for_playout())
        interruption = asyncio.ensure_future(interrupted_event.wait())
        await asyncio.wait([playout, interruption], return_when=asyncio.FIRST_COMPLETED)
        playout.cancel()
        interruption.cancel()
        interrupted = interrupted_event.is_set()
        position = self._pushed_duration
        if interrupted:
            position = max(0.0, position - self._interrupted_ms / 1000)
        self._pushed_duration = 0.0
        self._first_frame_emitted = False
        if self._interrupted_event is interrupted_event:
            self._interrupted_event = asyncio.Event()
            self._interrupted_ms = 0.0
        self.on_playback_finished(playback_position=position, interrupted=interrupted)


def _int16(frame: rtc.AudioFrame) -> Any:
    import numpy as np

    return np.frombuffer(frame.data, dtype=np.int16)


class RelayLiveKitCall:
    """First-party bridge between a Relay Call and a LiveKit Agents `AgentSession`.

    Developers work with Relay call IDs and LiveKit IO; media negotiation stays
    inside the transport.
    """

    def __init__(
        self,
        transport: RelayCallTransport,
        *,
        output_sample_rate: int = DEFAULT_OUTPUT_SAMPLE_RATE,
    ) -> None:
        self.transport = transport
        self.input = RelayAudioInput(transport)
        self.video_input = RelayVideoInput(transport)
        self.output = RelayAudioOutput(transport, output_sample_rate)
        self._session: Any = None
        self._closed = False

    @classmethod
    async def connect(
        cls,
        *,
        api_key: Optional[str] = None,
        call_id: str,
        base_url: str = DEFAULT_BASE_URL,
        room: Optional[CallRoom] = None,
        ice_servers: Union[list[Any], RelayIceServersProvider, None] = None,
        session_connect_timeout_ms: float = RESTART_CONNECT_TIMEOUT_MS,
        output_sample_rate: int = DEFAULT_OUTPUT_SAMPLE_RATE,
        on_warning: Any = None,
    ) -> "RelayLiveKitCall":
        """Join the Call's room as the agent (joining answers a ringing Call) and return once media is connected.

        ``api_key`` is the agent's Relay token. Raises only when the Call ends,
        the room closes or reports an error; cancelling closes the transport
        without ending the Call.
        """
        transport = RelayCallTransport(
            api_key=api_key,
            call_id=call_id,
            base_url=base_url,
            room=room,
            ice_servers=ice_servers,
            session_connect_timeout_ms=session_connect_timeout_ms,
            inbound_audio=LIVEKIT_ROOM_INPUT_AUDIO,
            on_warning=on_warning,
        )
        await transport.connect()
        return cls(transport, output_sample_rate=output_sample_rate)

    def attach(self, session: Any) -> None:
        """Make this call the session's audio input, video input and audio output."""
        if self._closed:
            raise RuntimeError("Relay LiveKit Call is closed.")
        if self._session is not None and self._session is not session:
            self.detach()
        self._session = session
        session.input.audio = self.input
        session.input.video = self.video_input
        session.output.audio = self.output

    def detach(self) -> None:
        session = self._session
        if session is None:
            return
        if session.input.audio is self.input:
            session.input.audio = None
        if session.input.video is self.video_input:
            session.input.video = None
        if session.output.audio is self.output:
            session.output.audio = None
        self._session = None

    async def wait_for_peer_audio(self, timeout_ms: float) -> None:
        """Return once the person's audio has arrived and the room shows them connected; start the session after it."""
        await self.transport.wait_for_peer_audio(timeout_ms)

    def diagnostics(self) -> RelayCallDiagnostics:
        """ICE, packet, room and restart facts for this call, with a one-line ``summary`` for logs."""
        return self.transport.diagnostics()

    def set_muted(self, muted: bool) -> None:
        self.transport.set_muted(muted)

    def end(self) -> None:
        """End the Relay Call."""
        self.transport.end()

    async def aclose(self) -> None:
        """Local cleanup; the Call is not ended."""
        if self._closed:
            return
        self._closed = True
        self.detach()
        self.output.close()
        await self.input.aclose()
        await self.video_input.aclose()
        await self.transport.aclose()
