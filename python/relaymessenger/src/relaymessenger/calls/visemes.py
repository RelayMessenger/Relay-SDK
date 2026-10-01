"""Optional lip-sync helper for Rive characters.

Text timings from a TTS engine become mouth shapes on a timeline, to send as a
``viseme`` View Model number with ``rive.set({"viseme": v}, at=...)``. The
TypeScript twin is ``@relaymessenger/sdk/calls`` ``visemes.ts``.

The ten shapes are Preston Blair's, the set Papagayo and Moho draw, in this
order: 0 rest, 1 AI, 2 E, 3 O, 4 U, 5 MBP, 6 FV, 7 L, 8 etc (S, T and the
other consonants), 9 WQ. Sounds map to shapes by Papagayo-NG's own table
(phonemes/preston_blair.json ``cmu_39_phoneme_conversion``). TTS engines
report characters, not phonemes, so each letter or digraph is first read as
the CMU phoneme it most often spells; English spelling is not phonetic, so
this is an approximation that keeps the mouth moving with the words.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence, TypedDict

VISEMES = ("rest", "AI", "E", "O", "U", "MBP", "FV", "L", "etc", "WQ")


@dataclass(frozen=True)
class VisemeCue:
    #: Milliseconds from the start of the audio the alignment describes.
    t: float
    #: Index into `VISEMES`.
    viseme: int


class CharacterAlignment(TypedDict):
    """ElevenLabs' ``alignment`` shape (Agents WebSocket ``audio`` event; TTS ``with-timestamps``)."""

    chars: Sequence[str]
    char_start_times_ms: Sequence[float]
    char_durations_ms: Sequence[float]


@dataclass(frozen=True)
class WordTiming:
    """One spoken word and its span, as Pipecat, Cartesia and LiveKit report them."""

    text: str
    start_ms: float
    end_ms: float


# Papagayo-NG ``cmu_39_phoneme_conversion``, keyed by CMU phoneme.
_CMU_TO_SHAPE = {
    "AA": "AI", "AE": "AI", "AH": "E", "AO": "O", "AW": "U", "AY": "AI", "B": "MBP", "CH": "WQ", "D": "E", "DH": "L",
    "EH": "E", "ER": "WQ", "EY": "E", "F": "FV", "G": "E", "HH": "E", "IH": "AI", "IY": "E", "JH": "WQ", "K": "E",
    "L": "L", "M": "MBP", "N": "etc", "NG": "E", "OW": "WQ", "OY": "WQ", "P": "MBP", "R": "L", "S": "etc", "SH": "WQ",
    "T": "E", "TH": "E", "UH": "U", "UW": "U", "V": "FV", "W": "WQ", "Y": "E", "Z": "etc", "ZH": "WQ",
}  # fmt: skip

# Two-letter spellings read as one sound, checked before single letters.
_DIGRAPHS = {
    "th": "TH", "sh": "SH", "ch": "CH", "ph": "F", "wh": "W", "ng": "NG", "oo": "UW", "ee": "IY", "qu": "W", "ck": "K",
}  # fmt: skip

# The CMU phoneme each letter most often spells.
_LETTERS = {
    "a": "AE", "b": "B", "c": "K", "d": "D", "e": "EH", "f": "F", "g": "G", "h": "HH", "i": "IH", "j": "JH", "k": "K",
    "l": "L", "m": "M", "n": "N", "o": "AO", "p": "P", "q": "K", "r": "R", "s": "S", "t": "T", "u": "UH", "v": "V",
    "w": "W", "x": "S", "y": "Y", "z": "Z",
}  # fmt: skip

# Sentence punctuation closes the mouth; spaces and anything else hold the shape before them.
_PAUSES = frozenset(".,!?;:…—")


def visemes_from_alignment(alignment: CharacterAlignment, *, end_with_rest: bool = True) -> list[VisemeCue]:
    """Character timings to mouth-shape cues in milliseconds of the audio they describe.

    Ends on ``rest`` where the last character ends unless ``end_with_rest`` is
    false (for a chunk the next one continues). Consecutive repeats are merged.
    """
    chars = list(alignment["chars"])
    starts = list(alignment["char_start_times_ms"])
    durations = list(alignment["char_durations_ms"])
    if not (len(chars) == len(starts) == len(durations)):
        raise ValueError("Alignment arrays must have the same length.")
    cues: list[VisemeCue] = []

    def push(t: float, viseme: int) -> None:
        if cues and cues[-1].viseme == viseme:
            return
        if cues and cues[-1].t == t:
            cues[-1] = VisemeCue(t, viseme)
            if len(cues) > 1 and cues[-2].viseme == viseme:
                cues.pop()
            return
        cues.append(VisemeCue(t, viseme))

    end = 0.0
    index = 0
    while index < len(chars):
        char = chars[index].lower()
        start = max(0.0, starts[index])
        end = max(end, start + max(0.0, durations[index]))
        if char in _PAUSES:
            push(start, 0)
            index += 1
            continue
        if len(char) != 1 or not char.isalpha():
            index += 1
            continue
        following = chars[index + 1].lower() if index + 1 < len(chars) else ""
        digraph = _DIGRAPHS.get(char + following)
        phoneme = digraph or _LETTERS.get(char)
        if phoneme is None:
            index += 1
            continue
        push(start, VISEMES.index(_CMU_TO_SHAPE[phoneme]))
        if digraph:
            index += 1
            end = max(end, max(0.0, starts[index]) + max(0.0, durations[index]))
        index += 1
    if cues and end_with_rest:
        push(end, 0)
    return cues


def alignment_from_words(words: Sequence[WordTiming]) -> CharacterAlignment:
    """Word timings to a character alignment: each word's span is shared evenly among its characters."""
    chars: list[str] = []
    starts: list[float] = []
    durations: list[float] = []
    for word in words:
        letters = list(word.text)
        if not letters:
            continue
        each = max(0.0, word.end_ms - word.start_ms) / len(letters)
        for position, char in enumerate(letters):
            chars.append(char)
            starts.append(word.start_ms + each * position)
            durations.append(each)
        chars.append(" ")
        starts.append(word.end_ms)
        durations.append(0.0)
    return {"chars": chars, "char_start_times_ms": starts, "char_durations_ms": durations}
