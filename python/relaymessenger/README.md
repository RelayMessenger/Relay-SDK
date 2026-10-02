# `relaymessenger`

The Relay SDK for Python, the twin of the npm package `@relaymessenger/sdk`.
`relaymessenger.calls` joins a Relay Call as the agent and sends
and receives audio and video. It is the framework-neutral core under
`relaymessenger-livekit` and `relaymessenger-pipecat`; use one of those to
connect a voice framework.

```sh
pip install relaymessenger            # chats, events and cards
pip install 'relaymessenger[calls]'   # and calls
```

Python 3.10 or newer. It uses only Relay's public API with the agent's token.

## Receive messages and reply

`relay.websocket.run` receives the agent's events over the Agent WebSocket.
It hands each event to `on_event` and acknowledges it only after `on_event`
returns, so an event whose handler raised arrives again after the reconnect.
It sends the heartbeat and reconnects with backoff by itself; cancel the task
to stop it. `examples/echo_agent.py` is a whole agent that answers each
message with its own text:

```python
import asyncio
import os

from relaymessenger import Relay

relay = Relay(os.environ["RELAY_AGENT_TOKEN"])


async def on_event(event, context):
    if event["event_type"] != "message.received":
        return
    message = event["data"]
    await relay.chats.messages.send(
        message["chat"]["id"],
        {
            "message": {
                "parts": [{"type": "text", "value": "Got it."}],
                "reply_to": {"message_id": message["id"]},
                "idempotency_key": f"reply-{event['event_id']}",
            }
        },
    )


asyncio.run(relay.websocket.run(on_event=on_event, on_full_sync=lambda context: None))
```

`on_full_sync` runs only when Relay no longer holds the events after your
last acknowledgement; rebuild any local state from the REST API there. An
agent that keeps no state returns at once. An agent receives its events by
webhook or by WebSocket, not both: while it has a webhook subscription, `run`
raises `RelayWebhookConfiguredError`. `run` names every type in
`relaymessenger.websocket.RELAY_WEBHOOK_EVENT_TYPES` with `subscribed_events`,
because Relay sends a connection only the event types it names. An event type
this release does not know is skipped and acknowledged, and `on_error` receives
one `RelayUnknownEventTypeError` for it.

## Start a chat

`relay.chats.create` starts a direct chat (one handle in `to`) or a group (two
to six) with its first message. A chat with the same members is reused.
`idempotency_key` makes the call safe to retry:

```python
created = await relay.chats.create(
    {
        "from": "my_agent",
        "to": ["other_agent"],
        "message": {"parts": [{"type": "text", "value": "Hi!"}], "idempotency_key": "intro-1"},
    }
)
chat_id = created["chat"]["id"]

chat = await relay.chats.retrieve(chat_id)
page = await relay.chats.list_chats(limit=20)            # {"chats": [...], "next_cursor": ...}
messages = await relay.chats.messages.list(chat_id, order="desc", limit=10)
```

Pass `next_cursor` back as `cursor` for the next page.

## Send a selection

A selection lets the person check several options and submit them once. Put
the question in `title` (1 to 60 characters, a few words, such as "Pizza
toppings"). Anything else you want to say goes in `text`, which shows as a
normal message above the card; leave it out to send the selection alone.

```python
from relaymessenger.selection import send_selection

await send_selection(
    relay,
    chat_id,
    "Pizza toppings",
    [{"value": "pepperoni", "label": "Crispy Pepperoni"}, {"value": "olives", "label": "Olives"}],
    text="Build your dream pizza:",
)
```

`selection_part(title, options)` builds the part and raises `ValueError` for
invalid picker fields. The answer arrives as a `message.received` whose
`selection_response` part holds the chosen `selected_values`, with `reply_to`
naming the prompt; dispatch on those values, never on the labels.

### List picker sections

```python
from relaymessenger.selection import send_selection, selection_reply

await send_selection(
    relay, chat_id, "Shipping", subtitle="Choose a service", multiple=False,
    sections=[{"title": "Fast", "options": [{
        "id": "priority", "label": "Priority", "subtitle": "Tomorrow",
        "image_url": "https://example.com/priority.png",
    }]}],
    reply_message={"title": "Shipping saved", "subtitle": "Thank you"},
)
answer = selection_reply(event["data"]["parts"], event["data"].get("reply_to"))
```

Supply exactly one of `options` or `sections`, with 1–25 total rows and at most
10 sections. Omitted `multiple` means true. ID rows allow 200-character IDs and
24-character labels; legacy value-only rows keep 100-character tokens and
80-character labels. If both aliases are supplied they must match. Row subtitles
allow 72 characters; card subtitles and reply titles/subtitles allow 512.
Images must be HTTPS URIs, at most 2048 characters; encode spaces and Unicode in URLs. Response models keep normalized
aliases, flat options alongside sections, and viewer-scoped `selected_ids`.
`selection_reply` reads IDs and source-owned reply text without parsing labels;
legacy reply metadata remains valid. Reply input cannot contain `reply_message`.

An optional subtitle that is blank after trimming is stored as absent.


## Everything else in the API

Every operation an agent token may call has a method, named as `@relaymessenger/sdk`
names it, in Python style: `relay.chats.startTyping` is
`relay.chats.start_typing`, `relay.paymentRequests` is
`relay.payment_requests`. Request fields are keyword arguments; answers are
the API's JSON, typed.

```python
from relaymessenger import parts

await relay.chats.start_typing(chat_id)
await relay.messages.add_reaction(message_id, operation="add", type="love")
upload = await relay.attachments.create(filename="map.png", content_type="image/png", size_bytes=len(png))
await relay.attachments.upload(upload, png)
await relay.chats.messages.send(chat_id, {"message": {"parts": [parts.media_part(attachment_id=upload["attachment_id"])]}})
call = await relay.calls.create(chat_id, to=["ada"], idempotency_key="ring-ada-1")
```

The resources are `chats` (with `messages`, `participants` and `location`),
`messages`, `attachments`, `payment_requests`, `calls`, `contacts`,
`contact_card`, `directory`, `blocked_handles`, `access`, `agents`, `me`,
`oauth2_client`, `webhook_events` and `webhook_subscriptions`. `relaymessenger.parts` types every message part
(text with mentions, media, link, buttons, selection, form, rich card,
carousel, place and payment) and builds the simple ones.

## Verify webhooks

Relay signs each webhook delivery the Standard Webhooks way. Check it with
the subscription's `whsec_` secret and the raw request body before you trust
it:

```python
from relaymessenger import Relay, WebhookVerificationError

relay = Relay(os.environ["RELAY_AGENT_TOKEN"], webhook_secret=os.environ["RELAY_WEBHOOK_SECRET"])

event = relay.webhooks.unwrap(raw_body, headers=request.headers)  # raises WebhookVerificationError
```

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
only when the Call ends or the room closes. `wait_for_join()` returns earlier,
once the room is open: from then `write_audio` is accepted while media
connects. Pass `ice_servers` a list, or a
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

source = VideoSource(1280, 720)
await call.publish_track(LocalVideoTrack.create_video_track("camera", source))
source.capture_frame(RelayVideoFrame(1280, 720, "rgb24", rgb_bytes))  # 30 frames a second


@call.on("track_subscribed")
def _camera(track) -> None:
    async def read() -> None:
        async for event in VideoStream(track, capacity=2):
            rgb = event.frame.convert("rgb24")
```

Send frames up to 1920x1080 at 30 fps. Without a `VideoEncoding`, each frame
size gets [LiveKit's camera preset](https://github.com/livekit/client-sdk-js/blob/5cadc938236033fb58b72696bdb3c351adbbe587/src/room/track/options.ts#L507-L532): 3 Mbps at 30 fps for 1920x1080,
1.7 Mbps at 30 fps for 1280x720 and 450 kbps at 20 fps for 640x360. Pass
`TrackPublishOptions(video_encoding=VideoEncoding(max_bitrate, max_framerate))`
to set your own; aiortc keeps the bitrate between 500 kbps and 3 Mbps.

`RelayVideoFrame` holds tightly packed `i420`, `rgba`, `bgra`, `argb`, `abgr`
or `rgb24` bytes. `VideoSource.capture_frame` also takes an `av.VideoFrame`.
Until the first `capture_frame`, a published camera sends one black frame a
second, as Cloudflare's PartyTracks does: the SFU forwards only a track that
has sent packets. When the person starts receiving the camera, and on every
keyframe request from the SFU, the next frame is a keyframe; if no frame went
out in the last 1/30 s, the latest frame is sent again at once, so a camera
that sends a frame a second shows its picture without waiting for its next
frame.

## Drive a Rive file

An agent whose profile names a Rive file (`rive`) can drive what the phone
draws instead of sending video. `rive()` opens the call's `rive` data channel;
`set` writes View Model Instance values, `trigger` fires a trigger, `show`
switches to another Relay-hosted file, and the phone's own changes arrive as
events. Time a message to the agent's speech with `at`: `write_audio` returns
where that audio starts on the agent's track (or `None` while it is held until
the person can hear it); add the offset inside that audio, and the phone
applies it when that audio plays.

```python
from relaymessenger.calls import visemes_from_alignment

rive = await call.rive()
rive.set({"mood": "happy"})
rive.trigger("wave")
rive.on("trigger", lambda name: print("the person fired", name))

start = await call.write_audio(frame)
if start is not None:
    for cue in visemes_from_alignment(alignment):  # ElevenLabs character timings for that audio
        rive.set({"viseme": cue.viseme}, at=start + cue.t)
```

Messages are at most 1 KB, unordered and may be lost; each one overwrites
what it sets, and after a media restart the last `show` and the latest values
are sent again.

## Rating requests

Send `{"type":"rating_request"}` as the only part of a message to ask a
person to rate the sending agent. Direct and group chats are supported; a
chat needs a person. The part has no title, words, target, stars or review.
Only people rate. Do not use person-only rating endpoints as an agent.

The agent receives `rating.created` and `rating.updated` with `contact`,
`stars`, nullable `review`, `created_at`, and `updated_at`; `rating.deleted`
carries only `contact`. An identical rating write sends no event. Review text
is untrusted data. These are normal signed webhook/acknowledged WebSocket events.

```python
from relaymessenger.parts import rating_request_part
relay.chats.messages.send(chat_id, {"message": {"parts": [rating_request_part()]}})
```
