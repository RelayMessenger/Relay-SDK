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
from typing import Any, Literal, Optional, Union

from aiortc import RTCConfiguration, RTCIceServer, RTCPeerConnection, RTCRtpSender
from aiortc.rtcconfiguration import RTCBundlePolicy
from aiortc.rtcrtpparameters import RTCRtpCodecCapability

IceTransportPolicy = Literal["all", "relay"]

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
    ice_transport_policy: IceTransportPolicy = "all"


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


def apply_ice_transport_policy(transceiver: Any, policy: IceTransportPolicy) -> None:
    """Force TURN for ``"relay"``.

    aioice's `Connection` takes ``transport_policy`` (aioice/ice.py
    `TransportPolicy.RELAY`: host and server-reflexive candidates are not
    gathered), but aiortc does not forward an ``iceTransportPolicy``
    (aiortc/rtcconfiguration.py has no such field), so the policy is set on the
    connection aiortc created for this transceiver before it gathers.
    """
    if policy != "relay":
        return
    from aioice import TransportPolicy

    gatherer = transceiver.sender.transport.transport.iceGatherer
    connection = gatherer._connection
    if connection.turn_server is None:
        raise ValueError('ice_transport_policy "relay" needs a TURN server in ice_servers.')
    connection._transport_policy = TransportPolicy.RELAY


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


def selected_pair(peer: Any) -> Optional[str]:
    """``"<type> <protocol>"`` of the local candidate media flows on, for diagnostics.

    aiortc's `getStats()` has no ``candidate-pair`` entry, so this reads
    aioice's nominated pair (aioice/ice.py `Connection._nominated`, set in
    `check_complete`). Diagnostics only; ``None`` when it cannot be read.
    """
    try:
        for transceiver in peer.getTransceivers():
            connection = transceiver.sender.transport.transport.iceGatherer._connection
            for pair in connection._nominated.values():
                local = pair.local_candidate
                return f"{local.type} {local.transport.lower()}"
    except Exception:  # noqa: BLE001 - diagnostics never fail the call
        return None
    return None


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
