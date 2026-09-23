"""aiortc peer connection setup for Cloudflare's Realtime SFU.

Twin of `createWeriftPeerConnection` (packages/livekit/src/engine-werift.ts):
``bundlePolicy: max-bundle`` and the caller's ICE servers. Cloudflare supplies
its own candidates in the answer and is ICE-lite, so aiortc's agent is the
controlling side (aiortc/rtcpeerconnection.py sets ``ice_controlling`` from the
remote ``a=ice-lite``).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Optional, Union

from aiortc import RTCConfiguration, RTCIceServer, RTCPeerConnection, RTCRtpSender
from aiortc.rtcconfiguration import RTCBundlePolicy
from aiortc.rtcicetransport import parse_stun_turn_uri
from aiortc.rtcrtpparameters import RTCRtpCodecCapability

#: H.264 constrained baseline, the only H.264 profile Cloudflare's SFU accepts
#: (engine-werift.ts `videoCodecs`), with packetization-mode 1.
H264_PROFILE_LEVEL_ID = "42e01f"


@dataclass
class RelayIceServer:
    """Standard ``RTCIceServer``: STUN or TURN URLs with optional credentials."""

    urls: Union[str, list[str]]
    username: Optional[str] = None
    credential: Optional[str] = None


@dataclass
class PeerConfig:
    ice_servers: list[RelayIceServer] = field(default_factory=list)


def normalize_ice_servers(servers: Any) -> list[RelayIceServer]:
    """Copy a list of `RelayIceServer` or ``{"urls", "username", "credential"}`` dicts."""
    out: list[RelayIceServer] = []
    for server in servers or []:
        if isinstance(server, RelayIceServer):
            urls = list(server.urls) if isinstance(server.urls, list) else server.urls
            out.append(RelayIceServer(urls=urls, username=server.username, credential=server.credential))
        elif isinstance(server, dict):
            urls = server["urls"]
            out.append(
                RelayIceServer(
                    urls=list(urls) if isinstance(urls, list) else urls,
                    username=server.get("username"),
                    credential=server.get("credential"),
                )
            )
        else:
            raise TypeError("ice_servers entries must be RelayIceServer or dicts with 'urls'.")
    return out


def _turn_rank(url: str) -> int:
    """0 for ``turn:`` over UDP on 3478, then other UDP, then TCP, then ``turns:``; STUN and unparsable URLs 0."""
    try:
        parsed = parse_stun_turn_uri(url)
    except ValueError:
        return 0
    if parsed["scheme"] == "turns":
        return 3
    if parsed["scheme"] != "turn":
        return 0
    if parsed["transport"] != "udp":
        return 2
    return 0 if parsed["port"] == 3478 else 1


def order_for_aiortc(servers: list[RelayIceServer]) -> list[RelayIceServer]:
    """Put ``turn:<host>:3478?transport=udp`` where aiortc looks first.

    aiortc keeps only the first STUN URL and the first usable TURN URL, in list
    order (aiortc/rtcicetransport.py `connection_kwargs`), and gathers every
    candidate before the offer can leave, up to aioice's 5 s (aioice/ice.py
    `gather_candidates`, ``timeout=5``). UDP on Cloudflare's primary port is
    the cheapest TURN allocation, so it goes first. Each server's URLs are
    sorted stably by that rank, and the servers too, with STUN-only servers
    kept first in their given order, so the first STUN URL does not change.
    """

    def urls(server: RelayIceServer) -> list[str]:
        return server.urls if isinstance(server.urls, list) else [server.urls]

    def server_rank(server: RelayIceServer) -> int:
        ranks = [_turn_rank(url) for url in urls(server) if url.lower().startswith("turn")]
        return min(ranks) if ranks else -1

    ordered = [
        RelayIceServer(
            urls=sorted(urls(server), key=_turn_rank) if isinstance(server.urls, list) else server.urls,
            username=server.username,
            credential=server.credential,
        )
        for server in servers
    ]
    return sorted(ordered, key=server_rank)


def create_peer_connection(config: PeerConfig) -> RTCPeerConnection:
    """An aiortc peer with max-bundle and the given ICE servers.

    aiortc uses one STUN and one TURN URL per peer (aiortc/rtcicetransport.py
    `connection_kwargs`: "only a single STUN server is supported", "only a
    single TURN server is supported"); the first of each kind is used.
    """
    servers = [
        RTCIceServer(urls=s.urls, username=s.username, credential=s.credential) for s in config.ice_servers
    ]
    return RTCPeerConnection(RTCConfiguration(iceServers=servers, bundlePolicy=RTCBundlePolicy.MAX_BUNDLE))


def prefer_h264(transceiver: Any) -> None:
    """Offer H.264 constrained baseline ``42e01f`` (and RTX) only on the published video."""
    capabilities = RTCRtpSender.getCapabilities("video").codecs
    preferred: list[RTCRtpCodecCapability] = [
        c
        for c in capabilities
        if c.mimeType.lower() == "video/h264" and c.parameters.get("profile-level-id") == H264_PROFILE_LEVEL_ID
    ]
    preferred += [c for c in capabilities if c.mimeType.lower() == "video/rtx"]
    transceiver.setCodecPreferences(preferred)


_CANDIDATE = re.compile(r"candidate:\S+\s+\d+\s+(\S+)\s+\d+\s+\S+\s+(\d+)\s+typ\s+(\S+)", re.IGNORECASE)


def parse_candidate(line: str) -> Optional[tuple[str, int, str]]:
    """``(transport, port, type)`` of an RFC 5245 candidate line."""
    match = _CANDIDATE.search(line)
    if not match:
        return None
    return match.group(1).lower(), int(match.group(2)), match.group(3).lower()


def media_codec(sdp: str, mid: Optional[str]) -> Optional[str]:
    """The first codec of the media section with ``a=mid:<mid>``, as ``"video/H264"``."""
    if mid is None:
        return None
    for section in sdp.split("\nm=")[1:]:
        lines = [line.strip() for line in section.split("\n")]
        if f"a=mid:{mid}" not in lines:
            continue
        kind = lines[0].split(" ")[0]
        payloads = lines[0].split(" ")[3:]
        for payload in payloads:
            for line in lines:
                if line.startswith(f"a=rtpmap:{payload} "):
                    return f"{kind}/{line.split(' ', 1)[1].split('/')[0]}"
    return None
