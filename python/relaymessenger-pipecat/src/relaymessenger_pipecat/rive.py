"""Drive the agent's Rive file from a Pipecat pipeline.

`RelayRiveProcessor` sits after the TTS service. It turns the TTS word
timestamps (``TTSTextFrame.pts``, which Pipecat sets for ElevenLabs, Cartesia,
Azure and the other word-timestamp services) into ``viseme`` values timed
against the agent's own audio, and the bot speaking frames into ``speaking``.
Both are View Model properties on the agent's Rive file; rename them, or set
either to ``None`` to leave it alone. Everything else the agent shows goes
through ``transport.call.rive()`` directly.
"""

from __future__ import annotations

import asyncio
from typing import Optional

from loguru import logger
from pipecat.frames.frames import (
    BotConnectedFrame,
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    CancelFrame,
    ClientConnectedFrame,
    EndFrame,
    Frame,
    InterruptionFrame,
    TTSAudioRawFrame,
    TTSStartedFrame,
    TTSTextFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from relaymessenger.calls import RelayRive, WordTiming, alignment_from_words, visemes_from_alignment

from .transport import RelayTransport

#: The last word of a turn has no next word to end it: allow this much per character.
LAST_WORD_MS_PER_CHAR = 70.0


class RelayRiveProcessor(FrameProcessor):
    """Mouth shapes and speaking state for a Rive character, placed right after the TTS service.

    ``Pipeline([transport.input(), stt, llm, tts, RelayRiveProcessor(transport), transport.output()])``

    A word's ``pts`` is the pipeline clock at the turn's first audio plus the
    word's offset in that audio (Pipecat ``TTSService.start_word_timestamps``).
    The processor reads the Relay audio clock (``audio_time_ms``) when the
    turn's first audio passes it, so each word lands at its offset into that
    audio on the agent's track, which is the ``t`` the phone plays it at.
    """

    def __init__(
        self,
        transport: RelayTransport,
        *,
        viseme_property: Optional[str] = "viseme",
        speaking_property: Optional[str] = "speaking",
    ) -> None:
        super().__init__()
        self._transport = transport
        self._viseme = viseme_property
        self._speaking = speaking_property
        self._rive: Optional[RelayRive] = None
        self._opening: Optional[asyncio.Task[None]] = None
        # The turn's anchors: pipeline clock (ns) and agent audio clock (ms) at its first audio.
        self._clock_anchor: Optional[int] = None
        self._audio_anchor: Optional[float] = None
        # The latest word, sent once the next word (or the turn's end) gives its end.
        self._pending: Optional[tuple[str, float]] = None

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if isinstance(frame, (BotConnectedFrame, ClientConnectedFrame)):
            # The call is connected: open the channel before the first word needs it.
            self._handle()
        elif isinstance(frame, TTSStartedFrame):
            self._new_turn()
        elif isinstance(frame, TTSAudioRawFrame) and self._audio_anchor is None:
            self._anchor()
        elif isinstance(frame, TTSTextFrame) and frame.pts:
            self._word(frame.text, frame.pts)
        elif isinstance(frame, BotStartedSpeakingFrame):
            self._set_speaking(True)
        elif isinstance(frame, BotStoppedSpeakingFrame):
            self._flush()
            self._set_speaking(False)
        elif isinstance(frame, InterruptionFrame):
            self._pending = None
            self._new_turn()
            self._set_untimed({self._viseme: 0} if self._viseme else {})
        elif isinstance(frame, (EndFrame, CancelFrame)) and self._opening is not None:
            await self.cancel_task(self._opening)
            self._opening = None
        await self.push_frame(frame, direction)

    def _new_turn(self) -> None:
        self._flush()
        self._clock_anchor = None
        self._audio_anchor = None

    def _anchor(self) -> None:
        call = self._transport.call
        if call is None:
            return
        try:
            self._audio_anchor = call.audio_time_ms()
        except Exception:
            return
        self._clock_anchor = self.get_clock().get_time()

    def _word(self, text: str, pts: int) -> None:
        if not self._viseme or self._clock_anchor is None or self._audio_anchor is None:
            return
        start = self._audio_anchor + (pts - self._clock_anchor) / 1_000_000
        if self._pending is not None:
            self._send_word(*self._pending, end=start, last=False)
        self._pending = (text, start)

    def _flush(self) -> None:
        if self._pending is None:
            return
        text, start = self._pending
        self._pending = None
        self._send_word(text, start, end=start + LAST_WORD_MS_PER_CHAR * max(1, len(text)), last=True)

    def _send_word(self, text: str, start: float, *, end: float, last: bool) -> None:
        rive = self._handle()
        if rive is None or not self._viseme:
            return
        alignment = alignment_from_words([WordTiming(text, max(0.0, start), max(start, end))])
        for cue in visemes_from_alignment(alignment, end_with_rest=last):
            rive.set({self._viseme: cue.viseme}, at=cue.t)

    def _set_speaking(self, speaking: bool) -> None:
        if self._speaking:
            self._set_untimed({self._speaking: speaking})

    def _set_untimed(self, values: dict[str, object]) -> None:
        rive = self._handle()
        if rive is not None and values:
            rive.set(values)  # type: ignore[arg-type]

    def _handle(self) -> Optional[RelayRive]:
        """The open channel's handle; opens it in the background on first use."""
        if self._rive is not None:
            return self._rive
        call = self._transport.call
        if call is not None and self._opening is None:
            self._opening = self.create_task(self._open(), name="relay-rive-open")
        return None

    async def _open(self) -> None:
        call = self._transport.call
        if call is None:
            return
        try:
            self._rive = await call.rive()
        except Exception as error:
            logger.warning(f"Relay Rive channel did not open: {error}")
            self._opening = None
