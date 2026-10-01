"""RelayRive: LiveKit's avatar-plugin shape driving the call's Rive channel."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any, Optional

import numpy as np
from livekit import rtc
from livekit.agents.types import TimedString

from relaymessenger.calls import VISEMES
from relaymessenger_livekit import RelayAudioOutput, RelayRive
from relaymessenger_livekit.transport import RelayAudioFrame


class FakeChannel:
    def __init__(self) -> None:
        self.sent: list[tuple[dict[str, Any], Optional[float]]] = []

    def set(self, values: dict[str, Any], *, at: Optional[float] = None) -> bool:
        self.sent.append((dict(values), at))
        return True


class FakeTransport(rtc.EventEmitter[str]):
    def __init__(self) -> None:
        super().__init__()
        self.channel = FakeChannel()
        self.clock_ms = 12_000.0
        self.playout = asyncio.get_running_loop().create_future()

    async def rive(self) -> FakeChannel:
        return self.channel

    def audio_time_ms(self) -> float:
        return self.clock_ms

    async def write_audio(self, frame: RelayAudioFrame) -> None:
        self.clock_ms += frame.samples.size / frame.sample_rate * 1000

    def queued_audio_ms(self) -> float:
        return 0.0

    def clear_audio(self) -> None:
        pass

    async def wait_for_playout(self) -> None:
        await asyncio.shield(self.playout)


class Collector:
    def __init__(self) -> None:
        self.texts: list[str] = []

    async def capture_text(self, text: str) -> None:
        self.texts.append(text)

    def flush(self) -> None:
        pass


def frame(ms: int, rate: int = 24_000) -> rtc.AudioFrame:
    n = rate * ms // 1000
    return rtc.AudioFrame(data=np.zeros(n, dtype=np.int16).tobytes(), sample_rate=rate, num_channels=1, samples_per_channel=n)


async def test_start_times_speaking_and_words_against_the_segments_audio() -> None:
    transport = FakeTransport()
    output = RelayAudioOutput(transport)  # type: ignore[arg-type]
    call = SimpleNamespace(transport=transport, output=output)
    downstream = Collector()
    session = SimpleNamespace(output=SimpleNamespace(transcription=downstream))
    avatar = RelayRive()
    await avatar.start(session, call)  # type: ignore[arg-type]
    assert avatar.rive is transport.channel

    await output.capture_frame(frame(20))
    # Words arrive with times relative to the segment's audio (LiveKit's synchronizer: start_time - pushed_duration).
    await session.output.transcription.capture_text(TimedString("map", start_time=0.0, end_time=0.3))
    await session.output.transcription.capture_text("plain text passes through")
    output.flush()
    transport.playout.set_result(None)
    for _ in range(10):
        await asyncio.sleep(0)

    sent = transport.channel.sent
    assert sent[0] == ({"speaking": True}, 12_000.0)
    visemes = [(at, VISEMES[values["viseme"]]) for values, at in sent if set(values) == {"viseme"}]
    assert visemes == [(12_000, "MBP"), (12_100, "AI"), (12_200, "MBP")]
    assert sent[-1] == ({"speaking": False, "viseme": 0}, None)
    assert downstream.texts == ["map", "plain text passes through"]


async def test_properties_can_be_renamed_or_left_alone() -> None:
    transport = FakeTransport()
    output = RelayAudioOutput(transport)  # type: ignore[arg-type]
    call = SimpleNamespace(transport=transport, output=output)
    session = SimpleNamespace(output=SimpleNamespace(transcription=None))
    await RelayRive(viseme_property=None, speaking_property="talking").start(session, call)  # type: ignore[arg-type]
    assert session.output.transcription is None
    await output.capture_frame(frame(20))
    assert transport.channel.sent == [({"talking": True}, 12_000.0)]
