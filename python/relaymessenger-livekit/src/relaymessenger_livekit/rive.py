"""Drive the agent's Rive file from a LiveKit Agents session on a Relay Call.

`RelayRive` has the shape of LiveKit's avatar plugins
(``AvatarSession().start(agent_session, room)``, docs.livekit.io
agents/models/avatar), with the Relay call in place of the LiveKit room: the
phone draws the agent's own Rive file instead of a provider's video.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from livekit.agents import utils
from livekit.agents.types import TimedString
from livekit.agents.voice.io import PlaybackFinishedEvent, PlaybackStartedEvent, TextOutput
from relaymessenger.calls import RelayRive as RelayRiveChannel
from relaymessenger.calls import WordTiming, alignment_from_words, visemes_from_alignment

from .agents import RelayLiveKitCall

logger = logging.getLogger("relaymessenger.livekit")


class RelayRive:
    """Mouth shapes and speaking state for a Rive character on a Relay Call.

    ``await RelayRive().start(session, call)`` opens the call's ``rive``
    channel. Each reply sets ``speaking`` true when its audio starts and false
    when it finishes or is interrupted. With ``AgentSession(...,
    use_tts_aligned_transcript=True)`` and a TTS that reports word times
    (ElevenLabs, Cartesia), each word also becomes ``viseme`` values (Preston
    Blair's ten mouths) timed against the agent's audio. Rename the properties,
    or pass ``None`` to leave one alone; use `rive` for anything else.
    """

    def __init__(self, *, viseme_property: Optional[str] = "viseme", speaking_property: Optional[str] = "speaking") -> None:
        self._viseme = viseme_property
        self._speaking = speaking_property
        self._call: Optional[RelayLiveKitCall] = None
        #: The call's Rive channel once `start` returns: ``set``, ``trigger``, ``show``, and events.
        self.rive: Optional[RelayRiveChannel] = None

    async def start(self, agent_session: Any, room: RelayLiveKitCall) -> None:
        self._call = room
        self.rive = await room.transport.rive()
        room.output.on("playback_started", self._playback_started)
        room.output.on("playback_finished", self._playback_finished)
        if self._viseme:
            agent_session.output.transcription = _RiveTranscription(self, agent_session.output.transcription)

    def _playback_started(self, _event: PlaybackStartedEvent) -> None:
        if self.rive is None or not self._speaking or self._call is None:
            return
        self.rive.set({self._speaking: True}, at=self._call.output.segment_start_ms)

    def _playback_finished(self, _event: PlaybackFinishedEvent) -> None:
        if self.rive is None:
            return
        values: dict[str, Any] = {}
        if self._speaking:
            values[self._speaking] = False
        if self._viseme:
            values[self._viseme] = 0
        if values:
            self.rive.set(values)

    def _word(self, word: TimedString) -> None:
        call = self._call
        if self.rive is None or call is None or not self._viseme:
            return
        anchor = call.output.segment_start_ms
        if anchor is None or not utils.is_given(word.start_time) or not utils.is_given(word.end_time):
            return
        timing = WordTiming(str(word).strip(), anchor + word.start_time * 1_000, anchor + word.end_time * 1_000)
        for cue in visemes_from_alignment(alignment_from_words([timing]), end_with_rest=False):
            self.rive.set({self._viseme: cue.viseme}, at=cue.t)


class _RiveTranscription(TextOutput):
    """Reads TTS-aligned words on their way to the session's transcription output."""

    def __init__(self, owner: RelayRive, next_in_chain: Optional[TextOutput]) -> None:
        super().__init__(label="RelayRive", next_in_chain=next_in_chain)
        self._owner = owner

    async def capture_text(self, text: str) -> None:
        if isinstance(text, TimedString):
            try:
                self._owner._word(text)
            except Exception:
                logger.exception("Relay Rive could not time a word")
        if self.next_in_chain is not None:
            await self.next_in_chain.capture_text(text)

    def flush(self) -> None:
        if self.next_in_chain is not None:
            self.next_in_chain.flush()
