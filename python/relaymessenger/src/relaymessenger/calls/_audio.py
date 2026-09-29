"""Opus audio in and out of aiortc, paced by the clock.

Twin of `WeriftAudioSource` / `WeriftAudioSink` in
`packages/livekit/src/engine-werift.ts`, on aiortc's pull model: aiortc's
`RTCRtpSender._run_rtp` awaits `track.recv()` once per packet and sends what it
returns at once (aiortc/rtcrtpsender.py `_next_encoded_frame`, `_run_rtp`), and
an `av.Packet` it receives is sent as-is with its ``pts`` as the RTP timestamp
offset (`OpusEncoder.pack`, aiortc/codecs/opus.py). So the track's ``recv()``
is the pacer: it returns one 20 ms Opus packet when the clock says one is due.
"""

from __future__ import annotations

import asyncio
import fractions
import time
from collections import deque
from dataclasses import dataclass
from typing import Any, Callable, Optional

import av
import numpy as np
from aiortc.mediastreams import MediaStreamError, MediaStreamTrack

from ._audio_format import (
    PACKET_FRAMES,
    PACKET_MS,
    PACKET_SAMPLES,
    WIRE_CHANNEL_COUNT,
    WIRE_SAMPLE_RATE,
    Int16Array,
    PacketClock,
    RtpAudioPacer,
    to_wire_format,
)

OPUS_TIME_BASE = fractions.Fraction(1, WIRE_SAMPLE_RATE)
#: aiortc's own Opus encoder settings (aiortc/codecs/opus.py `OpusEncoder`).
OPUS_BIT_RATE = 96_000


#: The pacer's wait; tests replace it to drive a fake clock.
_sleep = asyncio.sleep


def monotonic_ms() -> float:
    return time.monotonic() * 1000


@dataclass
class AudioSourceStats:
    opus_packets: int
    #: RTP packets carrying application audio.
    rtp_packets: int
    #: RTP packets carrying the silence frame sent while nothing is queued.
    silence_packets: int
    #: First and last packet of either kind, monotonic ms.
    first_rtp_at: Optional[float]
    last_rtp_at: Optional[float]
    #: Packets of either kind handed to aiortc in the last 5 s.
    recent_rtp_packets: int
    #: Encoded packets waiting for the pacer.
    queued: int
    #: A peer's sender pulled a packet in the last second.
    pacer_alive: bool
    #: Times the pacer fell more than 200 ms behind and restarted its clock (packets skipped, not burst).
    pacer_late_restarts: int = 0
    #: The first packet carrying application audio, monotonic ms.
    first_audio_at: Optional[float] = None
    #: Application audio is queued and held: the other participant is not receiving it yet.
    held: bool = False


@dataclass
class AudioSinkStats:
    #: Opus packets aiortc decoded and handed over (one per 20 ms).
    rtp_packets: int
    first_rtp_at: Optional[float]
    last_rtp_at: Optional[float]
    recent_rtp_packets: int


class _OpusEncoder:
    def __init__(self) -> None:
        codec = av.CodecContext.create("libopus", "w")
        codec.format = "s16"
        codec.layout = "stereo"
        codec.sample_rate = WIRE_SAMPLE_RATE
        codec.bit_rate = OPUS_BIT_RATE
        codec.options = {"application": "voip"}
        codec.time_base = OPUS_TIME_BASE
        self._codec = codec
        self._pts = 0

    def encode(self, interleaved: Int16Array) -> bytes:
        """One 20 ms stereo frame in, one Opus packet out (libopus frame size 960)."""
        frame = av.AudioFrame.from_ndarray(interleaved.reshape(1, -1), format="s16", layout="stereo")
        frame.sample_rate = WIRE_SAMPLE_RATE
        frame.pts = self._pts
        frame.time_base = OPUS_TIME_BASE
        self._pts += PACKET_FRAMES
        packets = self._codec.encode(frame)
        return b"".join(bytes(p) for p in packets)


class RelayAudioSource:
    """PCM16 in, paced 20 ms Opus packets out, across every peer of the call.

    Frames are accumulated into whole packets and encoded as they arrive, so an
    adapter may push far ahead of real time: `queued_ms()` is what has not left
    yet and `wait_for_drain()` resolves once the queued application audio has
    been handed to the sender (LiveKit's ``AudioSource.queued_duration`` /
    ``wait_for_playout`` shape).

    Each peer's sender pulls through its own `_RelayAudioTrack`; the pull waits
    until an `RtpAudioPacer` on the monotonic clock says the next packet is due,
    so the wire carries exactly 50 packets a second however late the event loop
    wakes. A pull with no application audio queued returns an Opus silence frame,
    as a live microphone track does: Cloudflare's SFU refuses to pull a
    published track that has carried no RTP (`empty_track_error` "No track data
    from remote peer", staging 2026-09-22, engine-werift.ts). aiortc starts
    pulling only once DTLS is connected (`RTCPeerConnection.__connect`), so
    silence flows from connect. Silence never counts toward `queued_ms()`.

    ``playing`` says whether application audio may leave now. While it is
    false the pull keeps sending silence and nothing queued is dropped; once
    it is true the queue plays from its first packet (PROTOCOL.md section 6b:
    hold the agent's audio until the other participant receives it, as
    LiveKit's room output waits for the subscription and never skips).
    """

    def __init__(self, clock: Callable[[], float] = monotonic_ms, *, playing: Callable[[], bool] = lambda: True) -> None:
        self._clock = clock
        self._playing = playing
        self._encoder = _OpusEncoder()
        #: 20 ms of digital silence, encoded once by the same encoder and reused.
        self._silence = self._encoder.encode(np.zeros(PACKET_SAMPLES, dtype=np.int16))
        self._packets: deque[bytes] = deque()
        self._pending: Int16Array = np.zeros(0, dtype=np.int16)
        self._rtp = PacketClock()
        self._opus_packets = 0
        self._application_rtp_packets = 0
        self._silence_packets = 0
        self._first_audio_at: Optional[float] = None
        self._pts = 0
        self._pacer = RtpAudioPacer()
        self._due = 0
        self._last_pull_at: Optional[float] = None
        self._started = False
        self._stopped = False
        self._drain_waiters: list[asyncio.Future[None]] = []
        self._current_track: Optional[_RelayAudioTrack] = None

    def stats(self) -> AudioSourceStats:
        now = self._clock()
        return AudioSourceStats(
            opus_packets=self._opus_packets,
            rtp_packets=self._application_rtp_packets,
            silence_packets=self._silence_packets,
            first_rtp_at=self._rtp.first_at,
            last_rtp_at=self._rtp.last_at,
            recent_rtp_packets=self._rtp.recent(now),
            queued=len(self._packets),
            pacer_alive=self._last_pull_at is not None and now - self._last_pull_at < 1_000,
            pacer_late_restarts=self._pacer.late_restarts,
            first_audio_at=self._first_audio_at,
            held=not self._drained() and not self._playing(),
        )

    def create_track(self) -> "_RelayAudioTrack":
        """A new aiortc track for one peer; aiortc stops it when that peer's sender stops.

        Only the newest track is served: a replaced peer's sender that pulls
        once more before it is cancelled gets `MediaStreamError`, never a packet.
        """
        track = _RelayAudioTrack(self)
        self._current_track = track
        return track

    def start(self) -> None:
        """The peer is connected. Kept for parity with the TypeScript engine; the pull starts the clock."""
        self._started = True

    def stop(self) -> None:
        self._stopped = True
        self.clear()

    def queued_ms(self) -> float:
        return len(self._packets) * PACKET_MS + (self._pending.size / WIRE_CHANNEL_COUNT / WIRE_SAMPLE_RATE) * 1_000

    async def wait_for_drain(self) -> None:
        self._flush_pending()
        if self._drained():
            return
        future: asyncio.Future[None] = asyncio.get_running_loop().create_future()
        self._drain_waiters.append(future)
        await future

    def clear(self) -> None:
        self._packets.clear()
        self._pending = np.zeros(0, dtype=np.int16)
        self._notify_drained()

    def on_data(self, samples: Int16Array, sample_rate: int, channel_count: int) -> None:
        if self._stopped:
            return
        wire = to_wire_format(samples, sample_rate, channel_count)
        merged = np.concatenate((self._pending, wire)) if self._pending.size else wire
        offset = 0
        while merged.size - offset >= PACKET_SAMPLES:
            self._packets.append(self._encoder.encode(np.ascontiguousarray(merged[offset : offset + PACKET_SAMPLES])))
            self._opus_packets += 1
            offset += PACKET_SAMPLES
        self._pending = merged[offset:].copy()

    def _flush_pending(self) -> None:
        """Pad a sub-packet remainder with silence so the tail of a segment reaches the wire."""
        if self._stopped or self._pending.size == 0:
            return
        padded = np.zeros(PACKET_SAMPLES, dtype=np.int16)
        padded[: self._pending.size] = self._pending
        self._pending = np.zeros(0, dtype=np.int16)
        self._packets.append(self._encoder.encode(padded))
        self._opus_packets += 1

    def _drained(self) -> bool:
        """Application audio only: the silence the pull keeps writing never counts."""
        return not self._packets and self._pending.size == 0

    def _notify_drained(self) -> None:
        if not self._drained():
            return
        waiters, self._drain_waiters = self._drain_waiters, []
        for waiter in waiters:
            if not waiter.done():
                waiter.set_result(None)

    async def next_packet(self, track: "_RelayAudioTrack") -> "av.Packet[Any]":
        """Wait until the next packet is due, then return queued audio, else silence."""
        while True:
            if self._stopped or track is not self._current_track:
                raise MediaStreamError
            now = self._clock()
            if self._due <= 0:
                self._due = self._pacer.take(now)
            if self._due > 0:
                self._due -= 1
                return self._take(now)
            await _sleep(max(0.0, (self._pacer.next_due_at() - now) / 1000))

    def _take(self, now: float) -> "av.Packet[Any]":
        application = self._packets.popleft() if self._packets and self._playing() else None
        packet = av.Packet(application if application is not None else self._silence)
        packet.pts = self._pts
        packet.time_base = OPUS_TIME_BASE
        self._pts += PACKET_FRAMES
        if application is not None:
            self._application_rtp_packets += 1
            if self._first_audio_at is None:
                self._first_audio_at = now
        else:
            self._silence_packets += 1
        self._rtp.mark(now)
        self._last_pull_at = now
        if not self._packets:
            self._notify_drained()
        return packet


class _RelayAudioTrack(MediaStreamTrack):
    """One peer's view of the call's `RelayAudioSource`."""

    kind = "audio"

    def __init__(self, source: RelayAudioSource) -> None:
        super().__init__()
        self._source = source

    async def recv(self) -> "av.Packet[Any]":
        if self.readyState != "live":
            raise MediaStreamError
        return await self._source.next_packet(self)


AudioHandler = Callable[[Int16Array, int, int], None]


class RelayAudioSink:
    """Reads the remote Opus track aiortc decodes (48 kHz stereo s16) and hands PCM16 in the requested format.

    aiortc decodes every packet its jitter buffer releases (aiortc/codecs/opus.py
    `OpusDecoder`, 48 kHz stereo s16); an `av.AudioResampler` converts to the
    format the caller asked for, as libopus decoding straight to that rate does
    in the TypeScript sink.
    """

    def __init__(
        self,
        track: MediaStreamTrack,
        sample_rate: int,
        channel_count: int,
        on_audio: AudioHandler,
        clock: Callable[[], float] = monotonic_ms,
    ) -> None:
        self.track = track
        self._sample_rate = sample_rate
        self._channel_count = channel_count
        self._on_audio: Optional[AudioHandler] = on_audio
        self._clock = clock
        self._rtp = PacketClock()
        self._resampler: Optional[av.AudioResampler] = None
        if not (sample_rate == WIRE_SAMPLE_RATE and channel_count == WIRE_CHANNEL_COUNT):
            self._resampler = av.AudioResampler(
                format="s16", layout="mono" if channel_count == 1 else "stereo", rate=sample_rate
            )
        self._task = asyncio.get_running_loop().create_task(self._run())

    def stats(self) -> AudioSinkStats:
        return AudioSinkStats(
            rtp_packets=self._rtp.count,
            first_rtp_at=self._rtp.first_at,
            last_rtp_at=self._rtp.last_at,
            recent_rtp_packets=self._rtp.recent(self._clock()),
        )

    async def _run(self) -> None:
        while True:
            try:
                frame = await self.track.recv()
            except (MediaStreamError, asyncio.CancelledError):
                return
            self._rtp.mark(self._clock())
            handler = self._on_audio
            if handler is None or not isinstance(frame, av.AudioFrame):
                continue
            frames = self._resampler.resample(frame) if self._resampler is not None else [frame]
            for out in frames:
                samples = out.to_ndarray().reshape(-1).astype(np.int16, copy=False)
                handler(samples, self._sample_rate, self._channel_count)

    def stop(self) -> None:
        self._on_audio = None
        self._task.cancel()
