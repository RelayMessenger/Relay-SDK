"""RelayTransport inside real Pipecat pipelines, with the Relay call faked at its event surface."""

from __future__ import annotations

import asyncio
import fractions
from typing import Any

import av
import numpy as np
import pytest
from pipecat.frames.frames import (
    ClientConnectedFrame,
    EndFrame,
    InterruptionFrame,
    OutputAudioRawFrame,
    OutputImageRawFrame,
    UserAudioRawFrame,
    UserImageRawFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.tests.utils import QueuedFrameProcessor
from pipecat.processors.frame_processor import FrameDirection
from pipecat.workers.runner import WorkerRunner

import relaymessenger_pipecat.transport as transport_module
from relaymessenger.calls import EventEmitter, RelayAudioFrame, RelayVideoFrame, RemoteVideoTrack
from relaymessenger_pipecat import RelayParams, RelayTransport


class FakeCall(EventEmitter[str]):
    """RelayCallTransport's surface: the events it emits and the calls the Pipecat client makes."""

    instances: list["FakeCall"] = []

    def __init__(self, **kwargs: Any) -> None:
        super().__init__()
        self.kwargs = kwargs
        self.connects = 0
        self.closes = 0
        self.cleared = 0
        self.queued = 0.0
        self.written: list[RelayAudioFrame] = []
        self.published: list[Any] = []
        FakeCall.instances.append(self)

    async def connect(self) -> None:
        self.connects += 1

    async def publish_track(self, track: Any) -> None:
        self.published.append(track)
        self.published_before_connect = self.connects == 0

    async def write_audio(self, frame: RelayAudioFrame) -> None:
        self.written.append(frame)

    def queued_audio_ms(self) -> float:
        return self.queued

    def clear_audio(self) -> None:
        self.cleared += 1

    async def aclose(self) -> None:
        self.closes += 1


@pytest.fixture(autouse=True)
def fake_call(monkeypatch: pytest.MonkeyPatch) -> None:
    FakeCall.instances = []
    monkeypatch.setattr(transport_module, "RelayCallTransport", FakeCall)


class FakeCameraTrack:
    """aiortc's decoded remote video track."""

    def __init__(self, frames: int) -> None:
        self.left = frames

    async def recv(self) -> av.VideoFrame:
        if self.left == 0:
            await asyncio.sleep(3600)
        self.left -= 1
        rgb = np.zeros((48, 64, 3), dtype=np.uint8)
        rgb[..., 0] = 220
        frame = av.VideoFrame.from_ndarray(rgb, format="rgb24").reformat(format="yuv420p")
        frame.pts, frame.time_base = 3000, fractions.Fraction(1, 90_000)
        return frame


def room_state(status: str) -> dict[str, Any]:
    person = {"contact_id": "person-1", "kind": "user", "connected": True, "video": True}
    return {"type": "roomState", "call": {"status": status}, "participants": [person]}


async def run(worker: PipelineWorker, during: Any) -> None:
    started = asyncio.Event()

    @worker.event_handler("on_pipeline_started")
    async def _started(_worker: Any, _frame: Any) -> None:
        started.set()

    async def drive() -> None:
        try:
            await asyncio.wait_for(started.wait(), 5)
            await during()
        finally:
            # Always end the pipeline, so a failed check fails the test instead of hanging it.
            await worker.queue_frame(EndFrame())

    runner = WorkerRunner(handle_sigint=False)
    await runner.add_workers(worker)
    results = await asyncio.wait_for(asyncio.gather(runner.run(), drive(), return_exceptions=True), 20)
    for result in results:
        if isinstance(result, BaseException):
            raise result


async def test_input_pushes_the_callers_audio_and_camera_and_reports_the_call() -> None:
    transport = RelayTransport(
        api_key="agent-token",
        call_id="call-1",
        params=RelayParams(audio_in_enabled=True, video_in_enabled=True),
    )
    received: asyncio.Queue[Any] = asyncio.Queue()
    worker = PipelineWorker(
        Pipeline([transport.input(), QueuedFrameProcessor(queue=received, queue_direction=FrameDirection.DOWNSTREAM)]),
        params=PipelineParams(audio_in_sample_rate=16_000),
        cancel_on_idle_timeout=False,
    )
    events: list[tuple[str, tuple[Any, ...]]] = []
    for name in ("on_connected", "on_first_participant_joined", "on_call_state_updated", "on_participant_left", "on_disconnected"):

        def record(name: str = name) -> Any:
            async def handler(_transport: Any, *args: Any) -> None:
                events.append((name, args))

            return handler

        transport.event_handler(name)(record())

    samples = (np.arange(320) * 50).astype(np.int16)

    async def during() -> None:
        call = FakeCall.instances[0]
        call.emit("room_state", room_state("in-progress"))
        call.emit("peer_audio")
        for _ in range(3):
            call.emit("audio", RelayAudioFrame(samples=samples, sample_rate=16_000, channel_count=1))
        remote = RemoteVideoTrack()
        call.emit("track_subscribed", remote)
        remote._attach(FakeCameraTrack(2))  # type: ignore[arg-type]
        seen: list[Any] = []
        while sum(isinstance(f, UserImageRawFrame) for f in seen) < 2 or sum(isinstance(f, UserAudioRawFrame) for f in seen) < 3:
            seen.append(await asyncio.wait_for(received.get(), 5))
        call.emit("ended", {"type": "ended", "reason": "completed"})
        remote._end()
        audio = [f for f in seen if isinstance(f, UserAudioRawFrame)]
        images = [f for f in seen if isinstance(f, UserImageRawFrame)]
        assert [(f.user_id, f.sample_rate, f.num_channels, f.audio) for f in audio] == [
            ("person-1", 16_000, 1, samples.tobytes())
        ] * 3
        assert (images[0].user_id, images[0].size, images[0].format, len(images[0].image)) == (
            "person-1",
            (64, 48),
            "RGB",
            64 * 48 * 3,
        )
        assert abs(images[0].image[0] - 220) < 8  # the red channel survives I420
        assert any(isinstance(f, ClientConnectedFrame) for f in seen)

    await run(worker, during)
    call = FakeCall.instances[0]
    assert len(FakeCall.instances) == 1 and call.connects == 1 and call.closes == 1
    assert (call.kwargs["api_key"], call.kwargs["call_id"]) == ("agent-token", "call-1")
    assert (call.kwargs["inbound_audio"].sample_rate, call.kwargs["inbound_audio"].channel_count) == (16_000, 1)
    names = [name for name, _ in events]
    assert names[0] == "on_connected" and names[-1] == "on_disconnected"
    assert ("on_first_participant_joined", ("person-1",)) in events
    assert ("on_call_state_updated", ("in-progress",)) in events
    assert ("on_participant_left", ("person-1", "completed")) in events


async def test_output_writes_audio_and_video_into_the_call_and_clears_on_interruption() -> None:
    transport = RelayTransport(
        api_key="agent-token",
        call_id="call-1",
        params=RelayParams(
            audio_out_enabled=True,
            video_out_enabled=True,
            video_out_is_live=True,
            video_out_width=64,
            video_out_height=48,
            audio_out_end_silence_secs=0,
        ),
    )
    worker = PipelineWorker(
        Pipeline([transport.input(), transport.output()]),
        params=PipelineParams(audio_out_sample_rate=24_000),
        cancel_on_idle_timeout=False,
    )
    tone = (np.sin(np.arange(960) / 5) * 8000).astype(np.int16)  # 40 ms at 24 kHz, one output chunk
    rgb = np.full((48, 64, 3), 90, dtype=np.uint8).tobytes()

    async def during() -> None:
        call = FakeCall.instances[0]
        # The camera was published before connect(), so it rides the first offer.
        assert len(call.published) == 1 and call.published_before_connect
        call.emit("room_state", room_state("in-progress"))
        call.emit("peer_audio")
        await worker.queue_frame(OutputAudioRawFrame(audio=tone.tobytes(), sample_rate=24_000, num_channels=1))
        await worker.queue_frame(OutputImageRawFrame(image=rgb, size=(64, 48), format="RGB"))
        for _ in range(100):
            if call.written and call.published and call.published[0].source._latest is not None:
                break
            await asyncio.sleep(0.02)
        await worker.queue_frame(InterruptionFrame())
        for _ in range(100):
            if call.cleared:
                break
            await asyncio.sleep(0.02)

    await run(worker, during)
    call = FakeCall.instances[0]
    assert call.written[0].sample_rate == 24_000 and call.written[0].channel_count == 1
    assert np.array_equal(call.written[0].samples, tone)
    track = call.published[0]
    assert (track.name, track.source.width, track.source.height) == ("pipecat-video", 64, 48)
    sent, _stamp = track.source._latest
    assert sent == RelayVideoFrame(64, 48, "rgb24", rgb)
    assert call.cleared >= 1
    assert call.closes == 1


async def test_audio_writes_wait_while_the_call_queue_is_over_its_size() -> None:
    transport = RelayTransport(api_key="agent-token", call_id="call-1", params=RelayParams(audio_out_queue_size_ms=200))
    client = transport._client
    call = FakeCall()
    client._call, client._connected = call, True  # type: ignore[assignment]
    call.queued = 500
    write = asyncio.ensure_future(client.write_audio(b"\0\0" * 240, 24_000, 1))
    await asyncio.sleep(0.1)
    assert not write.done()
    call.queued = 150
    assert await asyncio.wait_for(write, 1) is True


async def test_output_rejects_unknown_formats_and_short_images() -> None:
    transport = RelayTransport(api_key="agent-token", call_id="call-1")
    output = transport.output()
    assert output._relay_video_frame(OutputImageRawFrame(image=b"\0" * 12, size=(2, 2), format="YCbCr")) is None
    assert output._relay_video_frame(OutputImageRawFrame(image=b"\0" * 11, size=(2, 2), format="RGB")) is None
    frame = output._relay_video_frame(OutputImageRawFrame(image=b"\0" * 16, size=(2, 2), format="BGRA"))
    assert frame is not None and frame.format == "bgra"


def test_constructor_needs_a_call_and_a_token() -> None:
    with pytest.raises(ValueError):
        RelayTransport(api_key="agent-token", call_id=" ")
    with pytest.raises(ValueError):
        RelayTransport(call_id="call-1")


# ---- the real call transport under the Pipecat output, over a fake room and peer ----


class FakeRoom(EventEmitter[str]):
    """`CallRoom`'s surface as `RelayCallTransport` uses it; frames sent are kept."""

    def __init__(self) -> None:
        super().__init__()
        self.sent: list[dict[str, Any]] = []
        self.ice_servers: Any = [{"urls": ["stun:stun.cloudflare.com:3478"]}]
        self.state: Any = None

    async def connect(self) -> None:
        return None

    def send(self, frame: dict[str, Any]) -> None:
        self.sent.append(frame)

    def connected(self) -> None:
        self.send({"type": "connected"})

    def user_update(self, *, muted: bool, video: Any = None) -> None:
        self.send({"type": "userUpdate", "muted": muted})

    def close(self, *_: Any) -> None:
        return None


class Desc:
    def __init__(self, sdp: str, type: str) -> None:
        self.sdp, self.type = sdp, type


class FakeSender:
    def __init__(self, track: Any) -> None:
        self.track = track


class FakeTransceiver:
    def __init__(self, kind: str, mid: str, track: Any) -> None:
        self.kind, self.mid, self.direction = kind, mid, "sendonly"
        self.sender = FakeSender(track)

    def setCodecPreferences(self, codecs: list[Any]) -> None:
        self.codecs = codecs


class FakePeer(EventEmitter[str]):
    """aiortc's `RTCPeerConnection` as the transport drives it; the audio track is pulled by the test."""

    instances: list["FakePeer"] = []

    def __init__(self, config: Any) -> None:
        super().__init__()
        self.transceivers: list[FakeTransceiver] = []
        self.connectionState = self.iceConnectionState = self.iceGatheringState = "new"
        self.signalingState = "stable"
        self.localDescription: Any = None
        FakePeer.instances.append(self)

    def addTransceiver(self, track_or_kind: Any, direction: str) -> FakeTransceiver:
        kind = track_or_kind if isinstance(track_or_kind, str) else track_or_kind.kind
        t = FakeTransceiver(kind, str(len(self.transceivers)), None if isinstance(track_or_kind, str) else track_or_kind)
        self.transceivers.append(t)
        return t

    def getTransceivers(self) -> list[FakeTransceiver]:
        return self.transceivers

    async def createOffer(self) -> Desc:
        return Desc("offer", "offer")

    async def setLocalDescription(self, d: Desc) -> None:
        self.localDescription = Desc(f"v=0\r\na=candidate:1 1 udp 1 10.0.0.1 5000 typ host\r\n{d.type}", d.type)

    async def setRemoteDescription(self, d: Any) -> None:
        self.signalingState = "stable"

    async def close(self) -> None:
        return None

    def set_state(self, state: str) -> None:
        self.connectionState = state
        self.emit("connectionstatechange")


def receiving(tracks: list[str]) -> dict[str, Any]:
    person = {"contact_id": "person-1", "kind": "user", "connected": True, "video": False, "receiving": tracks}
    return {"type": "roomState", "call": {"status": "in-progress"}, "participants": [person]}


async def test_the_bots_audio_is_held_until_the_person_receives_it_then_plays_from_the_start(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from relaymessenger.calls import RelayCallTransport

    FakePeer.instances = []
    monkeypatch.setattr(
        transport_module, "RelayCallTransport", lambda **kwargs: RelayCallTransport(**kwargs, _peer_factory=FakePeer)
    )
    room = FakeRoom()
    transport = RelayTransport(
        call_id="call-1",
        room=room,  # type: ignore[arg-type]
        params=RelayParams(audio_out_enabled=True, audio_out_end_silence_secs=0),
    )
    worker = PipelineWorker(
        Pipeline([transport.input(), transport.output()]),
        params=PipelineParams(audio_out_sample_rate=48_000),
        cancel_on_idle_timeout=False,
    )

    async def answer_and_connect() -> None:
        # What Relay and the SFU do after join: answer the publish offer, then ICE connects.
        while not room.sent:
            await asyncio.sleep(0.005)
        room.emit("answer", {"type": "answer", "session_description": {"type": "answer", "sdp": "v=0\r\n"}})
        while FakePeer.instances[0].signalingState != "stable" or not any(f["type"] == "offer" for f in room.sent):
            await asyncio.sleep(0.005)
        await asyncio.sleep(0.01)
        FakePeer.instances[0].set_state("connected")

    connecting = asyncio.ensure_future(answer_and_connect())
    greeting = np.full(48_000 // 10, 1000, dtype=np.int16)  # 100 ms, five Opus packets

    async def during() -> None:
        call = transport._client.call
        assert call is not None and call._source is not None
        source = call._source
        track = FakePeer.instances[0].transceivers[0].sender.track
        await worker.queue_frame(OutputAudioRawFrame(audio=greeting.tobytes(), sample_rate=48_000, num_channels=1))
        for _ in range(200):
            if len(source._packets) >= 4:
                break
            await asyncio.sleep(0.01)
        await asyncio.sleep(0.1)  # the output has written every chunk it will write for now
        queued = list(source._packets)
        assert len(queued) >= 4
        # The person has not pulled the bot's audio yet: silence goes out, the greeting waits.
        assert [bytes(await track.recv()) for _ in range(5)] == [source._silence] * 5
        assert list(source._packets) == queued
        assert call.diagnostics().outbound.rtp_packets == 0
        room.emit("room_state", receiving(["video"]))
        assert [bytes(await track.recv()) for _ in range(2)] == [source._silence] * 2
        room.emit("room_state", receiving(["audio"]))
        # Receiving: the greeting plays from its first packet, every packet in order.
        assert [bytes(await track.recv()) for _ in range(len(queued))] == queued
        assert call.diagnostics().outbound.rtp_packets == len(queued)

    await run(worker, during)
    await connecting
