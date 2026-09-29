"""Wire constants, the RTP audio pacer, and PCM conversion.

Python twin of `packages/livekit/src/engine-werift.ts` (`RtpAudioPacer`,
`toWireFormat`, `PacketClock`). Everything here is pure so the unit tests can
drive it with a fake clock.
"""

from __future__ import annotations

import math
from collections import deque
from typing import Optional

import numpy as np
import numpy.typing as npt

#: Opus on the wire is always 48 kHz; Relay sends stereo so callers may pass either channel count.
WIRE_SAMPLE_RATE = 48_000
WIRE_CHANNEL_COUNT = 2
#: One RTP packet carries 20 ms: 960 frames at 48 kHz; the RTP timestamp advances by 960.
PACKET_MS = 20
PACKET_FRAMES = WIRE_SAMPLE_RATE * PACKET_MS // 1000
PACKET_SAMPLES = PACKET_FRAMES * WIRE_CHANNEL_COUNT

#: A pacer more than this far behind its clock re-anchors instead of bursting the
#: backlog (engine-werift.ts `WERIFT_MAX_CATCH_UP_MS`): 10 packets, so an
#: event-loop hiccup is made up in full and a real stall does not dump seconds
#: of audio on the receiver at once.
MAX_CATCH_UP_MS = 200

#: Packets counted for `diagnostics()`; the recent window is the last 5 s.
STATS_WINDOW_MS = 5_000

#: Rates libopus decodes to (`opus_decoder_create(Fs, channels)`), the only
#: values the TypeScript transport accepts for `inboundAudio`.
INBOUND_SAMPLE_RATES = frozenset({8_000, 12_000, 16_000, 24_000, 48_000})

Int16Array = npt.NDArray[np.int16]


class RtpAudioPacer:
    """Wall-clock RTP audio pacing.

    Packet ``n`` of a run is due at ``start + n * 20 ms``, so the average rate is
    exactly one packet per 20 ms however late the caller wakes. ``take(now)``
    returns how many packets are due and counts them as sent. A caller more than
    ``max_catch_up_ms`` behind re-anchors the run instead of bursting.
    """

    def __init__(self, packet_ms: float = PACKET_MS, max_catch_up_ms: float = MAX_CATCH_UP_MS) -> None:
        self.packet_ms = packet_ms
        self.max_catch_up_ms = max_catch_up_ms
        self._started_at: Optional[float] = None
        self._sent = 0
        #: Runs restarted because the caller fell more than ``max_catch_up_ms`` behind.
        self.late_restarts = 0

    def take(self, now: float) -> int:
        """Packets due by ``now`` (ms) and not yet sent; the first call of a run sends one at once."""
        if self._started_at is None or now - self.next_due_at() > self.max_catch_up_ms:
            if self._started_at is not None:
                self.late_restarts += 1
            self._started_at = now
            self._sent = 0
        due = math.floor((now - self._started_at) / self.packet_ms) + 1 - self._sent
        if due <= 0:
            return 0
        self._sent += due
        return due

    def next_due_at(self) -> float:
        """When the next packet is due (ms); ``-inf`` before the first ``take`` of a run."""
        if self._started_at is None:
            return -math.inf
        return self._started_at + self._sent * self.packet_ms

    def reset(self) -> None:
        """Forget the run; the next ``take`` starts a new clock."""
        self._started_at = None
        self._sent = 0


class PacketClock:
    """Monotone packet counter with first/last timestamps (ms) and a 5 s window."""

    def __init__(self) -> None:
        self.count = 0
        self.first_at: Optional[float] = None
        self.last_at: Optional[float] = None
        self._recent: deque[float] = deque()

    def mark(self, now: float) -> None:
        self.count += 1
        if self.first_at is None:
            self.first_at = now
        self.last_at = now
        self._recent.append(now)
        self._prune(now)

    def recent(self, now: float) -> int:
        self._prune(now)
        return len(self._recent)

    def _prune(self, now: float) -> None:
        floor = now - STATS_WINDOW_MS
        while self._recent and self._recent[0] < floor:
            self._recent.popleft()


def to_wire_format(samples: Int16Array, sample_rate: int, channel_count: int) -> Int16Array:
    """Convert interleaved PCM16 at any rate to interleaved 48 kHz stereo by linear interpolation.

    Same arithmetic as the TypeScript `toWireFormat`: output frame ``k`` samples
    input position ``k * rate / 48000`` between its two neighbours; a mono input
    feeds both channels.
    """
    samples = np.asarray(samples, dtype=np.int16)
    if sample_rate == WIRE_SAMPLE_RATE and channel_count == WIRE_CHANNEL_COUNT:
        return samples
    input_frames = samples.size // channel_count
    if input_frames == 0:
        return np.zeros(0, dtype=np.int16)
    frames = samples[: input_frames * channel_count].reshape(input_frames, channel_count).astype(np.float64)
    left = frames[:, 0]
    right = frames[:, 1] if channel_count > 1 else frames[:, 0]
    output_frames = math.floor(input_frames * WIRE_SAMPLE_RATE / sample_rate + 0.5)
    position = np.arange(output_frames, dtype=np.float64) * (sample_rate / WIRE_SAMPLE_RATE)
    base = np.minimum(np.floor(position).astype(np.int64), input_frames - 1)
    nxt = np.minimum(base + 1, input_frames - 1)
    fraction = position - np.floor(position)
    out = np.empty(output_frames * 2, dtype=np.float64)
    out[0::2] = left[base] * (1 - fraction) + left[nxt] * fraction
    out[1::2] = right[base] * (1 - fraction) + right[nxt] * fraction
    # JavaScript Math.round rounds halves up; numpy rounds halves to even.
    return np.floor(out + 0.5).astype(np.int16)
