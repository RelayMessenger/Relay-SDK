"""Pacing on a fake clock: exactly 50 packets a second, silence when idle, bounded catch-up."""

from __future__ import annotations

import asyncio
import random

import av
import numpy as np
import pytest

from relaymessenger.calls import _audio
from relaymessenger.calls._audio import RelayAudioSource
from relaymessenger.calls._audio_format import MAX_CATCH_UP_MS, PACKET_MS, RtpAudioPacer


class FakeClock:
    def __init__(self) -> None:
        self.now = 1_000.0

    def __call__(self) -> float:
        return self.now


def test_pacer_first_take_sends_one_then_one_per_20_ms() -> None:
    pacer = RtpAudioPacer()
    assert PACKET_MS == 20
    assert pacer.take(0) == 1
    assert pacer.take(19.9) == 0
    assert pacer.take(20) == 1
    assert pacer.next_due_at() == 40


def test_pacer_makes_up_a_late_wake_in_full() -> None:
    pacer = RtpAudioPacer()
    pacer.take(0)
    # 150 ms late: every packet due by then leaves, no more.
    assert pacer.take(170) == 8
    assert pacer.late_restarts == 0


def test_pacer_restarts_its_clock_after_a_stall_longer_than_200_ms() -> None:
    assert MAX_CATCH_UP_MS == 200
    pacer = RtpAudioPacer()
    pacer.take(0)
    assert pacer.take(20 + 201) == 1
    assert pacer.late_restarts == 1
    assert pacer.next_due_at() == 20 + 201 + 20


def test_pacer_averages_exactly_50_per_second_with_jittered_wakes() -> None:
    rng = random.Random(7)
    pacer = RtpAudioPacer()
    now, sent, last = 0.0, 0, 0.0
    while now < 60_000:
        sent += pacer.take(now)
        last = now
        now = max(now, pacer.next_due_at()) + rng.uniform(0, 45)
    # Packet n is due at n x 20 ms from the first: exactly floor(t / 20) + 1 have left by the last wake t.
    assert sent == int(last // 20) + 1
    assert sent >= 2995
    assert pacer.late_restarts == 0


@pytest.fixture
def fake_time(monkeypatch: pytest.MonkeyPatch) -> FakeClock:
    clock = FakeClock()
    rng = random.Random(3)

    real_sleep = asyncio.sleep

    async def fake_sleep(seconds: float) -> None:
        # A timer that fires 0-15 ms late, as an event loop under load does.
        clock.now += seconds * 1000 + rng.uniform(0, 15)
        await real_sleep(0)

    monkeypatch.setattr(_audio, "_sleep", fake_sleep)
    return clock


async def test_source_sends_50_packets_per_second_on_the_clock(fake_time: FakeClock) -> None:
    source = RelayAudioSource(clock=fake_time)
    track = source.create_track()
    stamps = []
    pts = []
    for _ in range(501):
        packet = await track.recv()
        stamps.append(fake_time.now)
        pts.append(packet.pts)
    rate = (len(stamps) - 1) / ((stamps[-1] - stamps[0]) / 1000)
    assert rate == pytest.approx(50.0, abs=0.2)
    # One RTP timestamp line: +960 per packet, silence included.
    assert np.all(np.diff(pts) == 960)
    stats = source.stats()
    assert stats.silence_packets == 501 and stats.rtp_packets == 0


async def test_source_sends_queued_audio_first_then_silence(fake_time: FakeClock) -> None:
    source = RelayAudioSource(clock=fake_time)
    track = source.create_track()
    await track.recv()  # silence from connect
    source.on_data(np.full(960 * 3, 1000, dtype=np.int16), 48_000, 1)  # 60 ms mono
    assert source.queued_ms() == 60
    for _ in range(3):
        await track.recv()
    assert source.queued_ms() == 0
    await track.recv()
    stats = source.stats()
    assert (stats.rtp_packets, stats.silence_packets) == (3, 2)


async def test_wait_for_drain_pads_the_tail_and_clear_releases(fake_time: FakeClock) -> None:
    source = RelayAudioSource(clock=fake_time)
    track = source.create_track()
    source.on_data(np.full(480, 1000, dtype=np.int16), 48_000, 1)  # 10 ms: under one packet
    assert source.queued_ms() == 10
    drain = asyncio.ensure_future(source.wait_for_drain())
    await asyncio.sleep(0)
    assert not drain.done()
    await track.recv()
    await asyncio.sleep(0)
    assert drain.done()
    source.on_data(np.full(960 * 50, 1000, dtype=np.int16), 48_000, 1)
    drain = asyncio.ensure_future(source.wait_for_drain())
    await asyncio.sleep(0)
    source.clear()
    await asyncio.sleep(0)
    assert drain.done() and source.queued_ms() == 0


async def test_a_replaced_peers_track_gets_no_packet(fake_time: FakeClock) -> None:
    source = RelayAudioSource(clock=fake_time)
    old = source.create_track()
    await old.recv()
    source.create_track()
    with pytest.raises(Exception):
        await old.recv()


async def test_opus_packets_decode_back_to_the_tone() -> None:
    source = RelayAudioSource()
    t = np.arange(48_000) / 48_000
    tone = (np.sin(2 * np.pi * 440 * t) * 9000).astype(np.int16)
    source.on_data(tone, 48_000, 1)
    decoder = av.CodecContext.create("opus", "r")
    pcm = []
    while source._packets:
        packet = av.Packet(source._packets.popleft())
        for frame in decoder.decode(packet):
            array = frame.to_ndarray()
            pcm.append(array[0] if frame.format.is_planar else array.reshape(-1)[0::2])
    left = np.concatenate(pcm).astype(np.float64)
    crossings = np.count_nonzero(np.diff(np.signbit(left[4800:-4800])))
    seconds = (left.size - 9600) / 48_000
    assert crossings / 2 / seconds == pytest.approx(440, rel=0.03)


async def test_idle_packets_are_opus_silence_the_sfu_accepts(fake_time: FakeClock) -> None:
    # Cloudflare's SFU refuses to pull a track that carried no RTP, so idle packets must be real Opus frames.
    source = RelayAudioSource(clock=fake_time)
    track = source.create_track()
    decoder = av.CodecContext.create("opus", "r")
    for _ in range(3):
        packet = await track.recv()
        assert len(bytes(packet)) > 0
        frames = decoder.decode(av.Packet(bytes(packet)))
        assert sum(f.samples for f in frames) == 960
        assert all(not np.any(f.to_ndarray()) for f in frames)


# ---- auto silence: Pipecat's ``audio_out_auto_silence`` (SmallWebRTC's ``RawAudioTrack``) ----


async def spin(times: int = 60) -> None:
    """Let a waiting pull poll ``times`` times; each poll moves the fake clock at least 5 ms."""
    for _ in range(times):
        await asyncio.sleep(0)


async def test_without_auto_silence_an_empty_queue_waits_and_the_timestamp_carries_on(fake_time: FakeClock) -> None:
    source = RelayAudioSource(clock=fake_time, auto_silence=False)
    track = source.create_track()
    source.on_data(np.full(960 * 2, 1000, dtype=np.int16), 48_000, 1)  # 40 ms: two packets
    first, second = await track.recv(), await track.recv()
    assert second.pts - first.pts == 960
    # Nothing queued: the pull waits, and no silence packet goes out however long it waits.
    waiting = asyncio.ensure_future(track.recv())
    before = fake_time.now
    await spin()
    assert fake_time.now - before >= 300
    assert not waiting.done()
    assert source.stats().silence_packets == 0
    source.on_data(np.full(960, 2000, dtype=np.int16), 48_000, 1)
    expected = source._packets[0]
    packet = await asyncio.wait_for(waiting, 1)
    assert bytes(packet) == expected
    # As SmallWebRTC's `frame.pts = self._timestamp`: one packet later, not the time waited.
    assert packet.pts == second.pts + 960
    stats = source.stats()
    assert (stats.rtp_packets, stats.silence_packets) == (3, 0)


async def test_with_auto_silence_an_empty_queue_sends_silence(fake_time: FakeClock) -> None:
    source = RelayAudioSource(clock=fake_time)
    track = source.create_track()
    source.on_data(np.full(960, 1000, dtype=np.int16), 48_000, 1)
    audio = await track.recv()
    silence = await asyncio.wait_for(track.recv(), 1)
    assert bytes(silence) == source._silence
    assert silence.pts == audio.pts + 960
    stats = source.stats()
    assert (stats.rtp_packets, stats.silence_packets) == (1, 1)


async def test_without_auto_silence_held_audio_still_sends_silence_until_it_may_play(fake_time: FakeClock) -> None:
    # Cloudflare's SFU forwards only a track that carries RTP, so the hello gate keeps silence flowing either way.
    playing = False
    source = RelayAudioSource(clock=fake_time, playing=lambda: playing, auto_silence=False)
    track = source.create_track()
    assert [bytes(await asyncio.wait_for(track.recv(), 1)) for _ in range(2)] == [source._silence] * 2
    source.on_data(np.full(960 * 2, 1000, dtype=np.int16), 48_000, 1)
    queued = list(source._packets)
    assert [bytes(await asyncio.wait_for(track.recv(), 1)) for _ in range(2)] == [source._silence] * 2
    assert list(source._packets) == queued and source.stats().held
    playing = True
    # Receiving: the queue plays from its first packet, then the pull waits instead of sending silence.
    assert [bytes(await asyncio.wait_for(track.recv(), 1)) for _ in range(2)] == queued
    waiting = asyncio.ensure_future(track.recv())
    await spin()
    assert not waiting.done()
    stats = source.stats()
    assert (stats.rtp_packets, stats.silence_packets) == (2, 4)
    waiting.cancel()
