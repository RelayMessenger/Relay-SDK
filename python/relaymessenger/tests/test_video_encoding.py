"""The published camera's encoding: LiveKit's preset per frame size, libx264's own level, the 42e01f offer.

Twin of packages/sdk/test/calls/video-encoding.test.ts. The presets are
LiveKit's (livekit/client-sdk-js src/room/track/options.ts:507-532 and
src/room/participant/publishUtils.ts:310-368 at 5cadc938).
"""

from __future__ import annotations

import asyncio
import fractions

import av
import numpy as np
import pytest
from aiortc import RTCPeerConnection

from relaymessenger.calls._engine import H264_PROFILE_LEVEL_ID, prefer_h264
from relaymessenger.calls.video import (
    RelayH264Encoder,
    VideoEncoding,
    default_video_encoding,
    use_relay_encoder,
)


def test_picks_livekits_camera_preset_for_the_frame_size() -> None:
    # VideoPresets (16:9): h1080, h720, h540, h360, h180.
    assert default_video_encoding(1920, 1080) == VideoEncoding(3_000_000, 30)
    assert default_video_encoding(1280, 720) == VideoEncoding(1_700_000, 30)
    assert default_video_encoding(960, 540) == VideoEncoding(800_000, 25)
    assert default_video_encoding(640, 360) == VideoEncoding(450_000, 20)
    assert default_video_encoding(320, 180) == VideoEncoding(160_000, 20)
    # Portrait uses the longer side; a size between presets takes the next one up.
    assert default_video_encoding(1080, 1920) == VideoEncoding(3_000_000, 30)
    assert default_video_encoding(1000, 562) == VideoEncoding(1_700_000, 30)
    # VideoPresets43 (4:3): h480, h1080.
    assert default_video_encoding(640, 480) == VideoEncoding(500_000, 20)
    assert default_video_encoding(1440, 1080) == VideoEncoding(2_300_000, 30)
    # Past the largest preset, the largest.
    assert default_video_encoding(7680, 4320) == VideoEncoding(8_000_000, 30)


def frame(width: int, height: int, pts: int = 0) -> av.VideoFrame:
    out = av.VideoFrame.from_ndarray(np.full((height, width, 3), 90, dtype=np.uint8), format="rgb24")
    out.pts = pts
    out.time_base = fractions.Fraction(1, 90_000)
    return out


def sps_level(encoder: RelayH264Encoder, width: int, height: int) -> str:
    """profile_idc, constraint flags and level_idc of the SPS the encoder writes for one keyframe."""
    for nal in encoder._encode_frame(frame(width, height), force_keyframe=True):
        if nal[0] & 0x1F == 7:
            return nal[1:4].hex()
    raise AssertionError("no SPS")


@pytest.mark.parametrize(
    ("width", "height", "level", "bitrate", "framerate"),
    [
        # profile_idc 66 with constraint_set0 and set1; level_idc 40, 31, 22.
        (1920, 1080, "42c028", 3_000_000, 30),
        (1280, 720, "42c01f", 1_700_000, 30),
        (640, 360, "42c016", 450_000, 20),
    ],
)
def test_encodes_at_the_level_and_preset_for_the_frame_size(
    width: int, height: int, level: str, bitrate: int, framerate: int
) -> None:
    encoder = RelayH264Encoder()
    encoder.target_bitrate = 3_000_000  # the highest REMB estimate aiortc accepts
    assert sps_level(encoder, width, height) == level
    assert encoder.codec is not None
    assert (encoder.codec.bit_rate, encoder.codec.framerate) == (bitrate, framerate)


def test_each_video_encoding_field_the_caller_sets_wins_over_the_preset() -> None:
    both = RelayH264Encoder(VideoEncoding(max_bitrate=2_000_000, max_framerate=15))
    both.target_bitrate = 3_000_000
    sps_level(both, 1920, 1080)
    rate_only = RelayH264Encoder(VideoEncoding(max_bitrate=1_000_000))
    rate_only.target_bitrate = 3_000_000
    sps_level(rate_only, 1920, 1080)
    assert both.codec is not None and rate_only.codec is not None
    assert (both.codec.bit_rate, both.codec.framerate) == (2_000_000, 15)
    assert (rate_only.codec.bit_rate, rate_only.codec.framerate) == (1_000_000, 30)


def test_a_lower_remb_estimate_still_lowers_the_bitrate() -> None:
    encoder = RelayH264Encoder()
    encoder.target_bitrate = 700_000
    sps_level(encoder, 1920, 1080)
    assert encoder.codec is not None and encoder.codec.bit_rate == 700_000


@pytest.mark.asyncio
async def test_the_published_video_offers_42e01f_and_encodes_with_relay_h264_encoder() -> None:
    peer = RTCPeerConnection()
    try:
        transceiver = peer.addTransceiver("video", direction="sendonly")
        prefer_h264(transceiver)
        encoding = VideoEncoding(max_bitrate=2_000_000)
        use_relay_encoder(transceiver.sender, encoding)
        offer = await peer.createOffer()
        fmtp = [line for line in offer.sdp.splitlines() if line.startswith("a=fmtp:") and "profile-level-id" in line]
        assert H264_PROFILE_LEVEL_ID == "42e01f"
        assert [line.split(" ", 1)[1] for line in fmtp] == [
            "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f"
        ]
        encoder = transceiver.sender._RTCRtpSender__encoder
        assert isinstance(encoder, RelayH264Encoder) and encoder.encoding is encoding
    finally:
        await peer.close()
        await asyncio.sleep(0)
