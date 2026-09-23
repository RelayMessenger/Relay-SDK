"""Pipecat transport for Relay Calls.

Shape copied from Pipecat's own transports (pipecat-ai 1.11
``transports/livekit/transport.py`` and ``transports/smallwebrtc/transport.py``):
a client shared by an input and an output processor, connected in ``setup``
and reference-counted so the second ``disconnect`` closes it; the input pushes
the caller's audio as ``UserAudioRawFrame`` and camera as ``UserImageRawFrame``;
the output implements ``write_audio_frame`` and ``write_video_frame``. The
media is `relaymessenger_calls.RelayCallTransport`: joining the Call's room as
the agent answers the Call.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any, Optional, Union

import numpy as np
from loguru import logger
from pipecat.audio.utils import create_stream_resampler
from pipecat.frames.frames import (
    BotConnectedFrame,
    CancelFrame,
    ClientConnectedFrame,
    EndFrame,
    Frame,
    InterruptionFrame,
    OutputAudioRawFrame,
    OutputImageRawFrame,
    StartFrame,
    UserAudioRawFrame,
    UserImageRawFrame,
    UserImageRequestFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessorSetup
from pipecat.transports.base_input import BaseInputTransport
from pipecat.transports.base_output import BaseOutputTransport
from pipecat.transports.base_transport import BaseTransport, TransportParams
from pydantic import BaseModel
from relaymessenger_calls import (
    DEFAULT_BASE_URL,
    CallRoom,
    LocalVideoTrack,
    RelayAudioFrame,
    RelayCallTransport,
    RelayIceServersProvider,
    RelayInboundAudioFormat,
    RelayVideoFrame,
    RemoteVideoTrack,
    VideoSource,
    VideoStream,
)
from relaymessenger_calls._audio_format import INBOUND_SAMPLE_RATES
from relaymessenger_calls.transport import AUDIO_SLICE_MS, RESTART_CONNECT_TIMEOUT_MS
from relaymessenger_calls.video import RelayVideoFormat

CAM_VIDEO_SOURCE = "camera"

#: Pipecat image modes (``video_out_color_format``) Relay can send, with bytes
#: per pixel; the same four Pipecat's LiveKit transport maps
#: (``LIVEKIT_VIDEO_BUFFER_TYPES``).
RELAY_VIDEO_FORMATS: dict[str, tuple[RelayVideoFormat, int]] = {
    "RGB": ("rgb24", 3),
    "RGBA": ("rgba", 4),
    "BGRA": ("bgra", 4),
    "ARGB": ("argb", 4),
}


class RelayParams(TransportParams):
    """Configuration parameters for the Relay transport.

    Video output publishes one ``"pipecat-video"`` camera track when
    ``video_out_enabled`` is set, sized by ``video_out_width`` and
    ``video_out_height``, from frames in ``video_out_color_format``.

    Parameters:
        audio_out_queue_size_ms: Audio the transport accepts ahead of the wire, in
            milliseconds, before ``write_audio_frame`` waits (the LiveKit
            transport's ``AudioSource`` queue, default 1000).
    """

    audio_out_queue_size_ms: int = 1000


class RelayCallbacks(BaseModel):
    """Callback handlers for Relay Call events."""

    on_connected: Callable[[], Awaitable[None]]
    on_disconnected: Callable[[], Awaitable[None]]
    on_participant_connected: Callable[[str], Awaitable[None]]
    on_participant_disconnected: Callable[[str, str], Awaitable[None]]
    on_call_state_updated: Callable[[str], Awaitable[None]]


class RelayTransportClient:
    """One Relay Call shared by the input and output processors."""

    def __init__(
        self,
        *,
        api_key: Optional[str],
        call_id: str,
        base_url: str,
        room: Optional[CallRoom],
        ice_servers: Union[list[Any], RelayIceServersProvider, None],
        session_connect_timeout_ms: float,
        on_warning: Optional[Callable[[str], None]],
        params: RelayParams,
        callbacks: RelayCallbacks,
        transport_name: str,
    ) -> None:
        self._api_key = api_key
        self._call_id = call_id
        self._base_url = base_url
        self._room = room
        self._ice_servers = ice_servers
        self._session_connect_timeout_ms = session_connect_timeout_ms
        self._on_warning = on_warning
        self._params = params
        self._callbacks = callbacks
        self._transport_name = transport_name
        self._call: Optional[RelayCallTransport] = None
        self._lock = asyncio.Lock()
        self._connected = False
        self._disconnect_counter = 0
        self._set_up = False
        self._in_sample_rate = 0
        self._audio_frames: asyncio.Queue[RelayAudioFrame] = asyncio.Queue()
        # Audio is queued only once the input reads it, so none arrives stale after StartFrame.
        self._reading_audio = False
        self._remote_video: Optional[RemoteVideoTrack] = None
        self._remote_video_changed = asyncio.Event()
        self._video_source: Optional[VideoSource] = None
        self._video_track: Optional[LocalVideoTrack] = None
        self._participant_id: Optional[str] = None
        self._participant_joined = False
        self._participant_left = False
        self._call_status: Optional[str] = None
        self._background: set[asyncio.Task[None]] = set()

    @property
    def call(self) -> Optional[RelayCallTransport]:
        """The Relay call transport, once connected."""
        return self._call

    @property
    def participant_id(self) -> Optional[str]:
        """The person's contact ID, from the Call room."""
        return self._participant_id

    async def setup(self, setup: FrameProcessorSetup) -> None:
        if self._set_up:
            return
        self._set_up = True
        self._in_sample_rate = self._params.audio_in_sample_rate or setup.audio_in_sample_rate

    async def connect(self) -> None:
        """Join the Call's room as the agent (answering a ringing Call) and publish."""
        async with self._lock:
            if self._connected:
                self._disconnect_counter += 1
                return
            logger.info(f"Joining Relay Call {self._call_id}")
            # The Call delivers the person's audio at any of Relay's inbound rates;
            # any other rate arrives at 48 kHz and the input resamples it.
            rate = self._in_sample_rate if self._in_sample_rate in INBOUND_SAMPLE_RATES else 48_000
            call = RelayCallTransport(
                api_key=self._api_key,
                call_id=self._call_id,
                base_url=self._base_url,
                room=self._room,
                ice_servers=self._ice_servers,
                session_connect_timeout_ms=self._session_connect_timeout_ms,
                inbound_audio=RelayInboundAudioFormat(sample_rate=rate, channel_count=self._params.audio_in_channels),
                on_warning=self._on_warning,
            )
            self._call = call
            self._attach(call)
            if self._params.video_out_enabled:
                self._video_source = VideoSource(self._params.video_out_width, self._params.video_out_height)
                self._video_track = LocalVideoTrack.create_video_track("pipecat-video", self._video_source)
            try:
                await call.connect()
            except BaseException:
                await self._close_call()
                raise
            self._connected = True
            self._disconnect_counter += 1
            logger.info(f"Joined Relay Call {self._call_id}")
            await self._callbacks.on_connected()

    async def disconnect(self) -> None:
        """Leave the room; the second caller (input and output both connect) closes the Call locally."""
        async with self._lock:
            self._disconnect_counter -= 1
            if not self._connected or self._disconnect_counter > 0:
                return
            self._connected = False
            logger.info(f"Leaving Relay Call {self._call_id}")
            await self._close_call()
            await self._callbacks.on_disconnected()

    def end(self) -> None:
        """End the Relay Call for both participants."""
        if self._call is not None:
            self._call.end()

    async def read_audio_frames(self) -> AsyncIterator[RelayAudioFrame]:
        self._reading_audio = True
        try:
            while True:
                yield await self._audio_frames.get()
        finally:
            self._reading_audio = False

    async def remote_video_track(self) -> RemoteVideoTrack:
        """The person's camera track, once it reaches the agent's peer."""
        while self._remote_video is None:
            self._remote_video_changed.clear()
            await self._remote_video_changed.wait()
        return self._remote_video

    async def write_audio(self, audio: bytes, sample_rate: int, num_channels: int) -> bool:
        call = self._call
        if not self._connected or call is None:
            return False
        samples = np.frombuffer(audio, dtype=np.int16)
        await call.write_audio(RelayAudioFrame(samples=samples, sample_rate=sample_rate, channel_count=num_channels))
        # Wait while the queue is over its size, as LiveKit's AudioSource.capture_frame does,
        # so the output's bot-speaking state follows the wire.
        while self._connected and call.queued_audio_ms() > self._params.audio_out_queue_size_ms:
            await asyncio.sleep(AUDIO_SLICE_MS / 1000)
        return True

    def clear_audio(self) -> None:
        if self._call is not None:
            self._call.clear_audio()

    def write_video(self, frame: RelayVideoFrame) -> bool:
        if not self._connected or self._video_source is None:
            return False
        self._video_source.capture_frame(frame)
        return True

    # ---- Relay call events ----------------------------------------------------------

    def _attach(self, call: RelayCallTransport) -> None:
        call.on("audio", self._on_audio)
        call.on("track_subscribed", self._on_track_subscribed)
        call.on("room_state", self._on_room_state)
        call.on("peer_audio", self._on_peer_audio)
        call.on("ended", self._on_ended)
        call.on("error", lambda error: logger.warning(f"{self._transport_name} Relay Call error: {error}"))

    def _on_audio(self, frame: RelayAudioFrame) -> None:
        if self._reading_audio:
            self._audio_frames.put_nowait(frame)

    def _on_track_subscribed(self, track: RemoteVideoTrack) -> None:
        self._remote_video = track
        self._remote_video_changed.set()

    def _on_room_state(self, frame: dict[str, Any]) -> None:
        person = next((p for p in frame["participants"] if p["kind"] == "user"), None)
        if person is not None:
            self._participant_id = person["contact_id"]
        status = frame["call"]["status"]
        if status != self._call_status:
            self._call_status = status
            self._spawn(self._callbacks.on_call_state_updated(status))

    def _on_peer_audio(self) -> None:
        # The person is in the room and their audio has reached the agent: a greeting will be heard.
        if self._participant_joined or self._participant_id is None:
            return
        self._participant_joined = True
        self._spawn(self._participant_connected(self._participant_id))

    async def _participant_connected(self, participant_id: str) -> None:
        # The camera is published only now. Until the agent has answered the room's
        # offer for the person's audio, Cloudflare's SFU refuses a second local
        # track on the agent's session (HTTP 406 on tracks/new, staging 2026-09-23).
        call, track = self._call, self._video_track
        if call is not None and track is not None:
            try:
                await call.publish_track(track)
            except Exception as error:  # noqa: BLE001 - the call goes on without the camera
                logger.error(f"{self._transport_name} could not publish video: {error}")
        await self._callbacks.on_participant_connected(participant_id)

    def _on_ended(self, frame: dict[str, Any]) -> None:
        if self._participant_left:
            return
        self._participant_left = True
        self._spawn(self._callbacks.on_participant_disconnected(self._participant_id or "", frame["reason"]))

    def _spawn(self, work: Awaitable[None]) -> None:
        task: asyncio.Task[None] = asyncio.ensure_future(work)
        self._background.add(task)
        task.add_done_callback(self._background.discard)

    async def _close_call(self) -> None:
        if self._video_source is not None:
            await self._video_source.aclose()
            self._video_source = None
        call = self._call
        if call is not None:
            await call.aclose()


class RelayInputTransport(BaseInputTransport):
    """Pushes the caller's audio and camera into the pipeline."""

    def __init__(self, transport: "RelayTransport", client: RelayTransportClient, params: RelayParams, **kwargs: Any):
        super().__init__(params, **kwargs)
        self._transport = transport
        self._client = client
        self._audio_in_task: Optional[asyncio.Task[None]] = None
        self._video_in_task: Optional[asyncio.Task[None]] = None
        self._image_requests: list[UserImageRequestFrame] = []
        self._resampler = create_stream_resampler()

    # FrameProcessor.setup narrows BaseObject.setup in Pipecat itself.
    async def setup(self, setup: FrameProcessorSetup) -> None:  # type: ignore[override]
        await super().setup(setup)
        await self._client.setup(setup)
        await self._client.connect()

    async def cleanup(self) -> None:
        await super().cleanup()  # type: ignore[no-untyped-call]
        await self._teardown()

    async def start(self, frame: StartFrame) -> None:
        await super().start(frame)
        if not self._audio_in_task and self._params.audio_in_enabled:
            self._audio_in_task = self.create_task(self._audio_in_task_handler())
        if not self._video_in_task and self._params.video_in_enabled:
            self._video_in_task = self.create_task(self._video_in_task_handler())
        await self.set_transport_ready(frame)

    async def stop(self, frame: EndFrame) -> None:
        await super().stop(frame)
        await self._teardown()

    async def cancel(self, frame: CancelFrame) -> None:
        await super().cancel(frame)
        await self._teardown()

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if isinstance(frame, UserImageRequestFrame):
            # The next camera frame answers it (SmallWebRTCInputTransport.request_participant_image).
            if frame.video_source is None:
                frame.video_source = CAM_VIDEO_SOURCE
            self._image_requests.append(frame)

    async def _teardown(self) -> None:
        await self._client.disconnect()
        if self._audio_in_task:
            await self.cancel_task(self._audio_in_task)
            self._audio_in_task = None
        if self._video_in_task:
            await self.cancel_task(self._video_in_task)
            self._video_in_task = None

    async def _audio_in_task_handler(self) -> None:
        async for relay_frame in self._client.read_audio_frames():
            audio = relay_frame.samples.astype(np.int16, copy=False).tobytes()
            if relay_frame.sample_rate != self.sample_rate:
                audio = await self._resampler.resample(audio, relay_frame.sample_rate, self.sample_rate)
            if not audio:
                continue
            await self.push_audio_frame(
                UserAudioRawFrame(
                    user_id=self._client.participant_id or "",
                    audio=audio,
                    sample_rate=self.sample_rate,
                    num_channels=relay_frame.channel_count,
                )
            )

    async def _video_in_task_handler(self) -> None:
        track = await self._client.remote_video_track()
        stream = VideoStream(track)
        try:
            async for event in stream:
                rgb = event.frame.convert("rgb24")
                image = UserImageRawFrame(
                    user_id=self._client.participant_id or "",
                    image=rgb.data,
                    size=(rgb.width, rgb.height),
                    format="RGB",
                )
                image.transport_source = CAM_VIDEO_SOURCE
                await self.push_video_frame(image)
                for request in self._image_requests[:]:
                    if request.video_source != CAM_VIDEO_SOURCE:
                        continue
                    answer = UserImageRawFrame(
                        user_id=request.user_id,
                        image=rgb.data,
                        size=(rgb.width, rgb.height),
                        format="RGB",
                        text=request.text,
                        append_to_context=request.append_to_context,
                        request=request,
                    )
                    answer.transport_source = CAM_VIDEO_SOURCE
                    await self.push_video_frame(answer)
                    self._image_requests.remove(request)
        finally:
            await stream.aclose()


class RelayOutputTransport(BaseOutputTransport):
    """Sends the pipeline's audio and video into the Call."""

    def __init__(self, transport: "RelayTransport", client: RelayTransportClient, params: RelayParams, **kwargs: Any):
        super().__init__(params, **kwargs)
        self._transport = transport
        self._client = client
        self._unsupported_video_formats: set[Optional[str]] = set()

    # FrameProcessor.setup narrows BaseObject.setup in Pipecat itself.
    async def setup(self, setup: FrameProcessorSetup) -> None:  # type: ignore[override]
        await super().setup(setup)
        await self._client.setup(setup)
        await self._client.connect()

    async def cleanup(self) -> None:
        await super().cleanup()  # type: ignore[no-untyped-call]
        await self._client.disconnect()

    async def start(self, frame: StartFrame) -> None:
        await super().start(frame)
        await self.set_transport_ready(frame)

    async def stop(self, frame: EndFrame) -> None:
        await super().stop(frame)
        await self._client.disconnect()

    async def cancel(self, frame: CancelFrame) -> None:
        await super().cancel(frame)
        await self._client.disconnect()

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        # Stop at once on interruption: drop audio accepted but not yet sent.
        if isinstance(frame, InterruptionFrame):
            self._client.clear_audio()

    async def write_audio_frame(self, frame: OutputAudioRawFrame) -> bool:
        return await self._client.write_audio(frame.audio, self.sample_rate, frame.num_channels)

    async def write_video_frame(self, frame: OutputImageRawFrame) -> bool:
        relay_frame = self._relay_video_frame(frame)
        if relay_frame is None:
            return False
        return self._client.write_video(relay_frame)

    def _relay_video_frame(self, frame: OutputImageRawFrame) -> Optional[RelayVideoFrame]:
        known = RELAY_VIDEO_FORMATS.get(frame.format) if frame.format else None
        if known is None:
            if frame.format not in self._unsupported_video_formats:
                self._unsupported_video_formats.add(frame.format)
                logger.error(f"{self} unsupported video color format for Relay output: {frame.format!r}")
            return None
        relay_format, depth = known
        width, height = frame.size
        if len(frame.image) != width * height * depth:
            logger.error(
                f"{self} video frame of size {width}x{height} and format {frame.format!r} "
                f"has {len(frame.image)} bytes, expected {width * height * depth}"
            )
            return None
        return RelayVideoFrame(width, height, relay_format, frame.image)


class RelayTransport(BaseTransport):
    """Joins a Relay Call as the agent participant.

    Joining answers a ringing Call. Construct it from the ``call.created``
    event with the agent's token, then use ``input()`` and ``output()`` in a
    pipeline.

    Event handlers available:

    - on_connected: The agent joined and its media is connected.
    - on_disconnected: The agent left the Call.
    - on_first_participant_joined: The person is in the Call and their audio
      reached the agent. Args: (participant_id: str)
    - on_participant_connected: Same moment. Args: (participant_id: str)
    - on_client_connected: Same moment, for templates shared across
      transports. Args: (participant: dict)
    - on_participant_disconnected: The Call ended. Args: (participant_id: str)
    - on_participant_left: The Call ended. Args: (participant_id: str, reason: str)
    - on_client_disconnected: The Call ended. Args: (participant: dict)
    - on_call_state_updated: The Call's status changed, for example
      ``ringing`` to ``in-progress``. Args: (state: str)

    Example::

        @transport.event_handler("on_first_participant_joined")
        async def on_first_participant_joined(transport, participant_id):
            await task.queue_frame(TTSSpeakFrame("Hello!"))

        @transport.event_handler("on_participant_left")
        async def on_participant_left(transport, participant_id, reason):
            await task.cancel()
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
        on_warning: Optional[Callable[[str], None]] = None,
        params: Optional[RelayParams] = None,
        input_name: Optional[str] = None,
        output_name: Optional[str] = None,
    ) -> None:
        """Initialize the Relay transport.

        Args:
            api_key: The agent's Relay token.
            call_id: The Call to join, from ``call.created``.
            base_url: Relay's API origin.
            room: A `CallRoom` to use instead of opening one.
            ice_servers: ICE servers, or a function returning them per media attempt
                (for short-lived TURN credentials). Defaults to the room's servers.
            session_connect_timeout_ms: How long a media session may take to connect
                before it is replaced.
            on_warning: Receives transport warnings.
            params: Transport configuration.
            input_name: Optional name for the input processor.
            output_name: Optional name for the output processor.
        """
        super().__init__(input_name=input_name, output_name=output_name)
        if not call_id.strip():
            raise ValueError("call_id is required.")
        if room is None and not api_key:
            raise ValueError("api_key is required.")
        self._params = params or RelayParams()
        self._client = RelayTransportClient(
            api_key=api_key,
            call_id=call_id,
            base_url=base_url,
            room=room,
            ice_servers=ice_servers,
            session_connect_timeout_ms=session_connect_timeout_ms,
            on_warning=on_warning,
            params=self._params,
            callbacks=RelayCallbacks(
                on_connected=self._on_connected,
                on_disconnected=self._on_disconnected,
                on_participant_connected=self._on_participant_connected,
                on_participant_disconnected=self._on_participant_disconnected,
                on_call_state_updated=self._on_call_state_updated,
            ),
            transport_name=self.name,
        )
        self._input: Optional[RelayInputTransport] = None
        self._output: Optional[RelayOutputTransport] = None
        for event in (
            "on_connected",
            "on_disconnected",
            "on_first_participant_joined",
            "on_participant_connected",
            "on_participant_disconnected",
            "on_participant_left",
            "on_client_connected",
            "on_client_disconnected",
            "on_call_state_updated",
        ):
            self._register_event_handler(event)

    def input(self) -> RelayInputTransport:
        if not self._input:
            self._input = RelayInputTransport(self, self._client, self._params, name=self._input_name)
        return self._input

    def output(self) -> RelayOutputTransport:
        if not self._output:
            self._output = RelayOutputTransport(self, self._client, self._params, name=self._output_name)
        return self._output

    @property
    def call(self) -> Optional[RelayCallTransport]:
        """The Relay call transport (diagnostics, mute), once connected."""
        return self._client.call

    @property
    def participant_id(self) -> Optional[str]:
        """The person's contact ID."""
        return self._client.participant_id

    def end(self) -> None:
        """End the Relay Call for both participants."""
        self._client.end()

    async def _on_connected(self) -> None:
        await self._call_event_handler("on_connected")
        if self._input:
            await self._input.push_frame(BotConnectedFrame())

    async def _on_disconnected(self) -> None:
        await self._call_event_handler("on_disconnected")

    async def _on_participant_connected(self, participant_id: str) -> None:
        await self._call_event_handler("on_first_participant_joined", participant_id)
        await self._call_event_handler("on_participant_connected", participant_id)
        await self._call_event_handler("on_client_connected", {"id": participant_id})
        if self._input:
            await self._input.push_frame(ClientConnectedFrame())

    async def _on_participant_disconnected(self, participant_id: str, reason: str) -> None:
        await self._call_event_handler("on_participant_disconnected", participant_id)
        await self._call_event_handler("on_participant_left", participant_id, reason)
        await self._call_event_handler("on_client_disconnected", {"id": participant_id})

    async def _on_call_state_updated(self, state: str) -> None:
        await self._call_event_handler("on_call_state_updated", state)
