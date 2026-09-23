# `relaymessenger-livekit`

`relaymessenger-livekit` connects Relay Calls to Python LiveKit Agents. It is
the Python twin of the npm package `@relaymessenger/livekit`. Relay stays
responsible for the Call resource and signaling; the package owns the WebRTC
peer (aiortc) and hands audio and video to LiveKit as `rtc.AudioFrame` and
`rtc.VideoFrame`. Application code does not handle Cloudflare, SDP, ICE, or
SFU credentials. It uses only Relay's public API: the Call room WebSocket
(`GET /v1/calls/{callId}/room`) with the agent's token.

```sh
pip install relaymessenger-livekit
```

Python 3.10 or newer. `livekit-agents`, `livekit` and `relaymessenger-calls`,
Relay's framework-neutral call core, are dependencies.

## Answer a Relay Call

Agents receive `call.created` through the normal Relay Webhook or acknowledged
Agent WebSocket. Joining that Call's authenticated room answers it; there is no
agent call URL or separate accept endpoint.

```python
import os

from livekit.agents import Agent, AgentSession
from livekit.plugins import google
from relaymessenger_livekit import RelayLiveKitCall


async def answer_call(call_id: str) -> RelayLiveKitCall:
    call = await RelayLiveKitCall.connect(
        api_key=os.environ["RELAY_AGENT_TOKEN"],
        call_id=call_id,
    )
    session = AgentSession(llm=google.realtime.RealtimeModel())
    call.attach(session)

    @call.transport.on("ended")
    def _ended(_frame: dict) -> None:
        asyncio.ensure_future(call.aclose())

    await call.wait_for_peer_audio(15_000)
    await session.start(Agent(instructions="You are a helpful voice agent."))
    return call
```

`RelayLiveKitCall.connect()` returns once the WebRTC media peer has reached
`connected`. `RelayAudioInput` hands the AgentSession the remote participant's
audio as 24 kHz mono PCM16 frames, the format of LiveKit's own room input.

`RelayAudioOutput` has the semantics of LiveKit's own
`_ParticipantAudioOutput`. Like LiveKit's, it holds the first frame until the
person is receiving the agent's audio, so a greeting that starts early is not
cut; the transport sends silence meanwhile and nothing is skipped. Then
`capture_frame()` hands each frame to the transport and returns at once, so the AgentSession may push a whole reply faster than
real time; the 20 ms pacer paces the wire. `flush()` closes the segment and
reports `playback_finished` only after the transport has drained.
`clear_buffer()` drops audio that has not reached the wire and reports the
segment as interrupted at the position that actually played.

On the transport, `await write_audio()` returns once its 10 ms slices are
queued, `queued_audio_ms()` is what has not left yet, and
`await wait_for_playout()` returns when the queue is empty (early on
`clear_audio()`).

Use `set_muted(True)` to publish participant mute state, `end()` to end the
Relay Call, and `await aclose()` for local cleanup. If the signaling
connection is replaced, `await call.transport.reconnect()` keeps the existing
media peer and replays the same audio publication so Relay can return its
cached answer.

## Live video: the agent sees the camera

`call.attach(session)` also sets `session.input.video` to a `RelayVideoInput`
that yields the caller's camera as `rtc.VideoFrame` (I420). The AgentSession's
built-in video sampler and its forwarding to a realtime model work unchanged,
so Gemini Live sees what the caller shows:

```python
from livekit.agents import Agent, AgentSession
from livekit.plugins import google
from relaymessenger_livekit import RelayLiveKitCall

call = await RelayLiveKitCall.connect(api_key=token, call_id=call_id)
session = AgentSession(llm=google.realtime.RealtimeModel())
call.attach(session)  # audio in, audio out, and the camera
await call.wait_for_peer_audio(15_000)
await session.start(Agent(instructions="Describe what the caller shows you."))
```

Send a video feed with LiveKit's names (`VideoSource.capture_frame`,
`LocalVideoTrack.create_video_track`):

```python
from livekit import rtc
from relaymessenger_livekit import LocalVideoTrack, VideoSource

source = VideoSource(640, 480)
track = LocalVideoTrack.create_video_track("camera", source)
await call.transport.publish_track(track)

# RGBA, BGRA, ARGB, ABGR, RGB24 or I420 bytes, tightly packed.
source.capture_frame(rtc.VideoFrame(640, 480, rtc.VideoBufferType.RGBA, rgba))

# Camera off, then on again; the track stays negotiated.
await call.transport.unpublish_track(track)
await call.transport.publish_track(track)
```

Read the other participant's video without an AgentSession:

```python
from relaymessenger_livekit import VideoStream


@call.transport.on("track_subscribed")
def _on_track(track) -> None:
    async def read() -> None:
        async for event in VideoStream(track, capacity=2):
            frame = event.frame  # rtc.VideoFrame, I420

    asyncio.ensure_future(read())


@call.transport.on("remote_video")
def _on_camera(on: bool) -> None:
    ...  # the other participant's camera started or stopped sending
```

Video is H.264 constrained baseline (`42e01f`), the profile Cloudflare's SFU
accepts, encoded by aiortc with libx264; received H.264 and VP8 are decoded.
Frames arrive upright as sent; aiortc does not negotiate the video-orientation
extension, so `rotation` is always 0. `call.transport.video_stats()` reports
frames captured, sent, decoded and dropped.

## ICE servers, TURN, restarts and diagnostics

By default the peer uses the servers the Call room sends after it joins:
Cloudflare's STUN server and TURN credentials that Relay mints for the call.
An agent behind a NAT that blocks direct paths connects through TURN with no
setup. Each restart uses the room's latest servers. A room that sends none
falls back to Cloudflare's STUN server (`stun:stun.cloudflare.com:3478`), as
Cloudflare's own Realtime echo example does.

aiortc uses only the first STUN URL and the first TURN URL, so the room's list
is ordered to put `turn:...:3478?transport=udp` first. A network that blocks
all outbound UDP therefore needs your own `turn:...?transport=tcp` server
first in `ice_servers`. aiortc also gathers
every candidate before the offer can leave, and a TURN server adds up to 5
seconds to that wait. On an open network, pass STUN only to skip it:

```python
from relaymessenger_livekit import RelayIceServer

call = await RelayLiveKitCall.connect(
    api_key=token,
    call_id=call_id,
    ice_servers=[RelayIceServer(urls="stun:stun.cloudflare.com:3478")],
)
```

Your `ice_servers` replaces the room's; pass your own TURN server the same way,
with `username` and `credential`. aiortc has no option to force every path
through TURN. `ice_servers` may also be a function of the restart count (sync
or async); it is called before every peer connection, so it can mint fresh TURN
credentials for each restart. The room's servers are on `room.ice_servers` and
its `ice_servers` event.

`connect()` has no overall deadline: when an SFU session is not `connected`
within `session_connect_timeout_ms` (5 seconds by default) of its answer,
becomes `failed`, or stays `disconnected` for 7 seconds, the transport closes
that peer, waits 250 ms (x1.1 per further attempt, at most 10 s), and
publishes from a new peer on a new session, for as long as the Call is ringing
or in progress. Outgoing audio and the published camera carry over. Each
replacement emits `restarted` with the reason and the replaced session's
summary. The room socket reconnects on its own after any close nobody asked
for (3 s, then x1.3, at most 10 s) without touching media, and sends a
heartbeat every 5 s.

`call.diagnostics()` returns the facts for logs, with a one-line `summary`,
for example `local: host 2, srflx 1, relay 0; remote: udp 1473;
states: …, connected 1.4s; in: 1234 rtp, 1234 frames, first 0.9s last 41.2s,
250/5s, 50.0/s; out: 2600 frames, 1300 opus, 1300 rtp, silence 700, first 1.1s
last 41.0s, 250/5s, 50.0/s, queue 0, pacer alive; room: 3 roomState, 1 offer,
1 open`: packets both ways and per second, silence packets and restarts. It has
no winning candidate pair: aiortc's public API does not expose it.

Like a live microphone, the published track sends one Opus packet every 20 ms
from the moment media connects until the transport closes, paced by the
monotonic clock: a late wake sends every packet due by then, so the wire
carries exactly 50 packets a second; a stall longer than 200 ms restarts the
clock instead of bursting. The track carries the caller's audio when some is
queued, Opus silence otherwise, because Cloudflare's SFU will not let the
other side pull a track that has carried no RTP. Silence never counts toward
`queued_audio_ms()` or `wait_for_playout()`. `on_warning` is called once per
call, with the summary, when outbound audio is queued but no packet has left
for 2 s while media is connected.

## Provider-neutral transport

`RelayCallTransport` is the WebRTC/PCM layer without LiveKit Agents:

```python
from relaymessenger_livekit import RelayAudioFrame, RelayCallTransport, RelayInboundAudioFormat

transport = RelayCallTransport(
    api_key=token,
    call_id=call_id,
    inbound_audio=RelayInboundAudioFormat(sample_rate=48_000, channel_count=1),
)


@transport.on("audio")
def _on_audio(frame: RelayAudioFrame) -> None:
    ...  # frame.samples: interleaved int16 numpy array


await transport.connect()
await transport.write_audio(RelayAudioFrame(samples=pcm, sample_rate=48_000, channel_count=1))
await transport.wait_for_playout()
```
