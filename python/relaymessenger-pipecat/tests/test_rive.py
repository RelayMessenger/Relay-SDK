"""RelayRiveProcessor: word timestamps become timed visemes; bot speaking frames become `speaking`."""

from __future__ import annotations

from typing import Any, Optional

from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    ClientConnectedFrame,
    InterruptionFrame,
    TTSAudioRawFrame,
    TTSStartedFrame,
    TTSTextFrame,
)
from pipecat.tests.utils import SleepFrame, run_test

from relaymessenger.calls import VISEMES
from relaymessenger_pipecat import RelayRiveProcessor

ANCHOR_NS = 5_000_000_000


class FakeRive:
    def __init__(self) -> None:
        self.sent: list[tuple[dict[str, Any], Optional[float]]] = []

    def set(self, values: dict[str, Any], *, at: Optional[float] = None) -> bool:
        self.sent.append((dict(values), at))
        return True


class FakeCall:
    def __init__(self) -> None:
        self.handle = FakeRive()
        self.opened = 0

    def audio_time_ms(self) -> float:
        return 12_000.0

    async def rive(self) -> FakeRive:
        self.opened += 1
        return self.handle


class FakeTransport:
    def __init__(self) -> None:
        self.call = FakeCall()


class FixedClock:
    def get_time(self) -> int:
        return ANCHOR_NS


class Processor(RelayRiveProcessor):
    def get_clock(self) -> Any:
        return FixedClock()


def word(text: str, offset_ms: int) -> TTSTextFrame:
    frame = TTSTextFrame(text, aggregated_by="word")
    frame.pts = ANCHOR_NS + offset_ms * 1_000_000
    return frame


async def test_words_become_visemes_at_their_offset_into_the_turns_audio() -> None:
    transport = FakeTransport()
    processor = Processor(transport)  # type: ignore[arg-type]
    frames = [
        ClientConnectedFrame(),
        SleepFrame(sleep=0.05),  # the channel opens in the background before speech starts
        TTSStartedFrame(),
        TTSAudioRawFrame(audio=b"\x00\x00" * 160, sample_rate=16_000, num_channels=1),
        word("map", 0),
        word("of", 300),
        SleepFrame(sleep=0.05),
        BotStoppedSpeakingFrame(),
    ]
    await run_test(processor, frames_to_send=frames, start_timeout=10)
    assert transport.call.opened == 1
    sent = transport.call.handle.sent
    visemes = [(at, VISEMES[values["viseme"]]) for values, at in sent if "viseme" in values]
    # "map" spans 0-300 ms from the audio clock's 12 000 ms: m, a, p at 100 ms each, no rest before "of".
    assert visemes == [
        (12_000, "MBP"), (12_100, "AI"), (12_200, "MBP"),
        # "of" is the last word: 70 ms a letter, then rest.
        (12_300, "O"), (12_370, "FV"), (12_440, "rest"),
    ]  # fmt: skip
    assert sent[-1] == ({"speaking": False}, None)


async def test_speaking_follows_the_bot_and_an_interruption_closes_the_mouth() -> None:
    transport = FakeTransport()
    processor = Processor(transport)  # type: ignore[arg-type]
    frames = [ClientConnectedFrame(), SleepFrame(sleep=0.05), BotStartedSpeakingFrame(), InterruptionFrame()]
    await run_test(processor, frames_to_send=frames, start_timeout=10)
    assert transport.call.handle.sent == [({"speaking": True}, None), ({"viseme": 0}, None)]


async def test_properties_can_be_renamed_or_left_alone() -> None:
    transport = FakeTransport()
    processor = Processor(transport, viseme_property=None, speaking_property="talking")  # type: ignore[arg-type]
    frames = [
        ClientConnectedFrame(),
        SleepFrame(sleep=0.05),
        TTSStartedFrame(),
        TTSAudioRawFrame(audio=b"\x00\x00" * 160, sample_rate=16_000, num_channels=1),
        word("hi", 0),
        BotStartedSpeakingFrame(),
    ]
    await run_test(processor, frames_to_send=frames, start_timeout=10)
    assert transport.call.handle.sent == [({"talking": True}, None)]
