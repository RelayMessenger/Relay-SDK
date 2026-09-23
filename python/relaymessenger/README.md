# `relaymessenger`

The Relay SDK for Python, the twin of the npm package `@relaymessenger/sdk`.
`relaymessenger.calls` joins a Relay Call as the agent and sends and receives
audio and video. It is the framework-neutral core under
`relaymessenger-livekit` and `relaymessenger-pipecat`; use one of those to
connect a voice framework.

```sh
pip install 'relaymessenger[calls]'
```

The `calls` extra installs the media dependencies (aiortc, av, numpy), the
way `livekit-agents[images]` does. Python 3.10 or newer. It uses only Relay's
public API: the Call room WebSocket (`GET /v1/calls/{callId}/room`) with the
agent's token. The package owns the WebRTC peer (aiortc), so your code never
handles SDP, ICE, or SFU credentials.

## Answer a Call

Agents receive `call.created` through a Relay webhook or the Agent WebSocket.
Joining the Call's room answers it:

```python
import os

from relaymessenger.calls import RelayCallTransport


async def answer(call_id: str) -> RelayCallTransport:
    call = RelayCallTransport(api_key=os.environ["RELAY_AGENT_TOKEN"], call_id=call_id)
    await call.connect()  # returns once media is connected
    return call
```

`connect()` rebuilds the media peer on a new session when one dies, and raises
only when the Call ends or the room closes. Pass `ice_servers` a list, or a
function that returns one per attempt, to use your own TURN credentials.

## Exchange audio

The person's audio arrives as `audio` events of PCM16. Send yours with
`write_audio`; a 20 ms pacer sets the pace on the wire. Until the person is
receiving your audio, what you write is held and silence goes out; it then
plays from the start, so a greeting written early is heard whole:

```python
import numpy as np

from relaymessenger.calls import RelayAudioFrame


@call.on("audio")
def _heard(frame: RelayAudioFrame) -> None:
    ...  # frame.samples, frame.sample_rate, frame.channel_count


await call.write_audio(RelayAudioFrame(np.zeros(480, dtype=np.int16), 48_000, 1))
await call.wait_for_playout()
```

`clear_audio()` drops audio that has not left, `set_muted()` publishes mute
state, `end()` ends the Call for both sides, and `await aclose()` cleans up
locally without ending it.

## Send and read video

Publish a camera with LiveKit's names, and read the other participant's
camera from `track_subscribed`. Publish before `connect()` to send the camera
with the audio from the first offer; publishing later adds it to the session:

```python
from relaymessenger.calls import LocalVideoTrack, RelayVideoFrame, VideoSource, VideoStream

source = VideoSource(640, 480)
await call.publish_track(LocalVideoTrack.create_video_track("camera", source))
source.capture_frame(RelayVideoFrame(640, 480, "rgb24", rgb_bytes))


@call.on("track_subscribed")
def _camera(track) -> None:
    async def read() -> None:
        async for event in VideoStream(track, capacity=2):
            rgb = event.frame.convert("rgb24")
```

`RelayVideoFrame` holds tightly packed `i420`, `rgba`, `bgra`, `argb`, `abgr`
or `rgb24` bytes. `VideoSource.capture_frame` also takes an `av.VideoFrame`.
Until the first `capture_frame`, a published camera sends one black frame a
second, as Cloudflare's PartyTracks does: the SFU forwards only a track that
has sent packets. When the person starts receiving the camera, and on every
keyframe request from the SFU, the next frame is a keyframe; if no frame went
out in the last 1/30 s, the latest frame is sent again at once, so a camera
that sends a frame a second shows its picture without waiting for its next
frame.
