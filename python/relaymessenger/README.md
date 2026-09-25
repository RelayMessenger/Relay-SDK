# `relaymessenger`

The Relay SDK for Python, the twin of the npm package `@relaymessenger/sdk`.
`relaymessenger.a2ui` sends [A2UI](https://a2ui.org) cards to a chat and reads
their taps. `relaymessenger.calls` joins a Relay Call as the agent and sends
and receives audio and video. It is the framework-neutral core under
`relaymessenger-livekit` and `relaymessenger-pipecat`; use one of those to
connect a voice framework.

```sh
pip install relaymessenger            # cards
pip install 'relaymessenger[calls]'   # cards and calls
```

Python 3.10 or newer. It uses only Relay's public API with the agent's token.

## Send a card

A card is an A2UI v0.9.1 surface in a message part,
`{"type": "data", "media_type": "application/a2ui+json", "data": [...]}`.
`send_card` creates the surface, sends its components and, when you give one,
its data model. Components come from Relay's catalog (`RELAY_CATALOG_ID`, the
A2UI basic catalog plus `PaymentRequest`); one must have the id `root`:

```python
import os

from relaymessenger import Relay
from relaymessenger.a2ui import read_a2ui_tap, send_card, update_card

relay = Relay(os.environ["RELAY_AGENT_TOKEN"])

BET = [
    {"id": "root", "component": "Card", "child": "body"},
    {"id": "body", "component": "Column", "children": ["title", "status", "bet"]},
    {"id": "title", "component": "Text", "text": "Lakers win tonight?", "variant": "h3"},
    {"id": "status", "component": "Text", "text": {"path": "/status"}},
    {"id": "bet_label", "component": "Text", "text": "Bet $50"},
    {
        "id": "bet",
        "component": "Button",
        "child": "bet_label",
        "variant": "primary",
        "action": {"event": {"name": "place_bet", "context": {"side": "yes", "stake": 50}}},
    },
]

await send_card(relay, chat_id, "bet-lakers", BET, data_model={"status": "Open"})
```

A tap on the button reaches your agent as `message.received`, through its
webhook or the Agent WebSocket, with the A2UI `action` in a data part.
`read_a2ui_tap` takes the event, or its raw JSON body, and returns the tap or
`None`. Answer by changing the same surface: `update_card` changes the card in
place for everyone in the chat and adds no message:

```python
async def on_event(event: dict) -> None:
    tap = read_a2ui_tap(event)
    if tap is None or tap.name != "place_bet":
        return
    await update_card(
        relay,
        tap.chat_id,
        tap.surface_id,
        components=[{"id": "body", "component": "Column", "children": ["title", "status"]}],
        data_model=f"Done: ${tap.context['stake']} on {tap.context['side']}",
        path="/status",
    )
```

`tap.context` is the button's `action.event.context`, and `tap.data_model` is
the surface's data model when you created it with `send_data_model=True`.
`delete_card` removes the surface; a message whose every surface is deleted is
removed for everyone. `client_capabilities(event)` lists the catalogs the
reader's app draws.

Relay applies each A2UI message of a send in order. The ones it did not apply
come back in the response's `a2ui_errors`, each an A2UI `error` message with a
JSON Pointer `path`; a send that applied nothing raises `RelayAPIError` with
the same `a2ui_errors`. To send A2UI messages you built yourself, use
`send_a2ui`, or put `a2ui_part(messages)` in `relay.chats.messages.send`. The
builders (`card`, `create_surface`, `update_components`, `update_data_model`,
`delete_surface`) and the types (`A2uiDataPart`, `A2uiServerMessage`,
`A2uiActionMessage`, `A2uiErrorMessage`, ...) follow A2UI v0.9.1's schemas field
for field.

## Answer a Call

The `calls` extra installs the media dependencies (aiortc, av, numpy), the
way `livekit-agents[images]` does. It uses the Call room WebSocket
(`GET /v1/calls/{callId}/room`) with the agent's token. The package owns the
WebRTC peer (aiortc), so your code never handles SDP, ICE, or SFU credentials.

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
