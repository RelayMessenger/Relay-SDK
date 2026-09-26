# `@relaymessenger/sdk`

TypeScript client for Relay v1.

## Selection

The SDK exposes `SelectionPart`, `SelectionPartResponse` (including read-only
viewer-relative `has_responded`), and `SelectionResponsePart` through the
existing message and event unions.

```ts
import { partsWithSelection } from "@relaymessenger/sdk";

const parts = partsWithSelection("I can go deep on any of these.", {
  type: "selection",
  title: "Topics",
  options: [
    { value: "research", label: "Research" },
    { value: "design", label: "Design" },
  ],
});
// Send with relay.chats.messages.send(chatId, { message: { parts, idempotency_key } }).
```

The question goes in `title`: trimmed, 1 to 60 characters, a few words such as
"Pizza toppings". It is the card's title in the chat and the sheet's title. The
text part is optional; when present it is an ordinary chat bubble above the
card, and `partsWithSelection(undefined, selection)` sends the selection alone.

`selectionPart` validates a complete part (`type` may be left out), returning a
normalized part or an error string. The title is limited to 60 characters,
options to 25, trimmed labels to 80 characters, and explicit case-sensitive
ASCII token values to 100. Unknown fields, duplicate values, a missing or blank
title, and blank labels are rejected.

Selection inherits existing Chat membership rules: at most one human user,
with multiple agents allowed. Only the human user can respond; agents cannot.
The durable per-user response claim applies across that user's devices and
idempotency keys, without expanding group membership.

`answerMessages` accepts a `selection` fenced JSON block containing
`{"title": "...", "options": [...]}`; the words outside it, if any, become the
text above the card. It keeps invalid blocks as text with an error and never combines a
selection with buttons. Existing buttons retain their behavior.

The person opens the prompt, checks any number of options and submits them
once; checking sends nothing and only the submit does. A person answers a given
selection once, and reopening it afterwards shows what they chose without
letting them change it.

The user's new reply is exactly literal `• ` + each selected source label
joined with `\n`, then
`{ type: "selection_response", selected_values: ["research", "design"] }`,
in source-option order, with explicit `reply_to.message_id` and `part_index`.
The user client keeps its existing outgoing idempotency identity for retries.
The server also accepts exact legacy comma-joined source labels only for
compatibility. iOS may draw a checkmark in place of each bullet and repeat the
prompt's title, as presentation only, but portable text stays bulleted.
Metadata has no additional display text. Use `selected_values` and the source
reply target to dispatch your own handler, rather than splitting labels.
Signed webhook `unwrap` and WebSocket `onEvent` default types expose this
metadata after narrowing to `message.received`.

The CLI, Pi, OpenClaw, the Claude Code channel, MCP, and the Chat SDK adapter
include selection guidance and structured inbound discovery.
`selectionReply(parts, replyTo)` discovers values and the explicit source target.

## Payment

Ask a person to pay in two steps. Create a payment request on your
organization's connected Stripe account, then send its `checkout_url` as a
`payment` part, the only part of its Message. The card reads its amount and
title from the request. The money settles to your Stripe account.

```ts
const request = await relay.paymentRequests.create(
  {
    amount: 2400, // minor units
    currency: "usd",
    description: "House blend, 250 g",
    category: "physical_goods", // or "digital_goods", "donation"
  },
  { idempotencyKey: `order-${orderId}` },
);
await relay.chats.messages.send(chatId, {
  message: {
    parts: [{ type: "payment", checkout_url: request.checkout_url }],
    idempotency_key: crypto.randomUUID(),
  },
});
```

For a subscription, pass `mode: "subscription"` and a recurring `price_id`
instead of `amount` and `currency`. `relay.paymentRequests.list`, `retrieve`
and `cancel` read and cancel requests. The status moves only on Stripe's word
or your cancel, and arrives as `payment.succeeded`, `payment.canceled` or
`payment.expired`; a paid request also adds a `payment_receipt` message from
the payer, which arrives as `message.received`.

A model inside a bridge never holds the Relay token, so it gives the request's
fields and the bridge creates it. `answerMessages` lifts one `payment` fenced
JSON block (`description`, `category`, `amount` and `currency`, or
`mode: "subscription"` with `price_id`) out of the words and returns it as
`payment`, checked by `paymentRequestFields`; `createPaymentPart` creates the
request on the card Message's own idempotency key and returns the `payment`
part to send last. A second payment, or a payment beside buttons or a
selection, stays text with an error. `PAYMENT_GUIDANCE` is the text the CLI,
Pi, OpenClaw, MCP and the Claude Code channel carry; the text bridges also
carry `PAYMENT_BLOCK_INSTRUCTION`.

## Location

Ask the person in a one-to-one chat to share their location, then read it.
The request puts a `location_request` Message from your agent in the chat;
the person chooses whether to share and for how long.

```ts
await relay.chats.location.request(chatId);

// After `location.sharing.started` arrives:
const { data } = await relay.chats.location.retrieve(chatId);
for (const feature of data.features) {
  const [longitude, latitude] = feature.geometry.coordinates;
  console.log(feature.properties.handle, latitude, longitude, feature.properties.updated_at);
}
```

`data` is a GeoJSON FeatureCollection, longitude first; `features` is empty
when nobody is sharing. `location.sharing.started` and
`location.sharing.stopped` fire when a share begins or ends, never when the
position moves, so read again when you need the latest position. A request
returns 409 in a group chat, in a chat with no person, or while the person is
already sharing, and 429 with `Retry-After` after one request in the same chat
in the last 60 seconds. The person's card arrives as a `location` part that
carries the share's state, never its position.

## Cards (A2UI)

A card is an [A2UI v0.9.1](https://a2ui.org) surface, sent as a `data` part:
`{ type: "data", media_type: "application/a2ui+json", data: [A2UI messages] }`.
Send the card, read the tap, then change the same card in place.

```ts
import Relay, {
  A2UI_BASIC_CATALOG_ID,
  readA2uiAction,
  sendA2uiSurface,
  updateA2uiSurface,
} from "@relaymessenger/sdk";

const relay = new Relay({
  apiKey: process.env.RELAY_AGENT_TOKEN!,
  webhookSecret: process.env.RELAY_WEBHOOK_SECRET!,
});

// 1. Send a card with a button.
await sendA2uiSurface(relay, chatId, {
  surfaceId: "order-1042",
  catalogId: A2UI_BASIC_CATALOG_ID,
  components: [
    { id: "root", component: "Card", child: "body" },
    { id: "body", component: "Column", children: ["title", "status", "confirm"] },
    { id: "title", component: "Text", text: "Oat latte, large", variant: "h3" },
    { id: "status", component: "Text", text: { path: "/status" } },
    { id: "confirm_label", component: "Text", text: "Confirm order" },
    {
      id: "confirm",
      component: "Button",
      child: "confirm_label",
      variant: "primary",
      action: { event: { name: "confirm_order", context: { order: "1042" } } },
    },
  ],
  dataModel: { status: "Waiting for you" },
}, { idempotency_key: "order-1042-card" });

// 2. The tap arrives as message.received.
const event = relay.webhooks.unwrap(rawBody, { headers });
const tap = readA2uiAction(event);
if (tap?.action.name === "confirm_order" && event.event_type === "message.received") {
  // 3. Change the same card to its done state. No new Message is added.
  await updateA2uiSurface(relay, event.data.chat.id, tap.action.surfaceId, {
    components: [
      { id: "body", component: "Column", children: ["title", "status"] },
    ],
    dataModel: { path: "/status", value: `Confirmed, order ${tap.action.context.order}` },
  });
}
```

`sendA2uiSurface` sends `createSurface`, `updateComponents` and, with
`dataModel`, `updateDataModel` in one data part. `updateA2uiSurface` sends
`updateComponents` and `updateDataModel` for a surface already in the chat;
components replace their namesakes by `id`. A surface's first
`updateComponents` holds the component with the id `root`. `deleteA2uiSurface` sends
`deleteSurface`; when every surface of a Message is deleted, the Message reads
back with no parts and a non-null `unsent_at`. Each takes the rest of the
Message as its fourth argument: `text` becomes a text part before the card,
and `reply_to`, `idempotency_key`, `silent` and `metadata` pass through.
`a2uiPart` wraps any list of A2UI messages in a data part for
`relay.chats.messages.send`.

Relay applies each A2UI message on its own, checked against A2UI's schemas and
the catalog the surface names; a component, property or value the catalog does
not define is refused. The messages it could not apply come back in the
response's `a2ui_errors`: each gives `part_index` and `data_index` in your
request and `a2ui_message`, A2UI's own `error` message, whose `path` points
inside the failing message's body. A send that applies nothing throws a
`RelayAPIError` (404 unknown or deleted surface, 409 a `surfaceId` already live
in the chat, 422 anything else) whose `body.a2ui_errors` lists each.

Every `message.received` carries `metadata.a2uiClientCapabilities`: the
catalogs Relay's app draws, in order of preference, `RELAY_A2UI_CATALOG_ID`
(every basic catalog component and function, plus `PaymentRequest`) and
`A2UI_BASIC_CATALOG_ID`. When a surface sets `sendDataModel: true`, each tap
also carries that surface's data model; `readA2uiAction` returns it as
`dataModel`. A tap reaches only the person who tapped and the agent that
created the surface. Only an agent sends `createSurface`, `updateComponents`,
`updateDataModel` and `deleteSurface`; any agent in the chat may update any
surface in it.

## Chat permissions

Relay Chats support one human user with one or more agents. Contacts, Handles,
and Participants remain generic API types, but selectable participants are
agents. Agent-to-agent Chats remain supported. This Agent SDK does not expose phone address-book syncing, mutual
contacts, human discovery, or human invite links.

Agents and users have the same generic Chat API permissions. Creating or
reusing a Chat containing a user requires every agent (including an agent
sender) to be that user's added, unblocked Contact. Adding an agent checks the
new target and any acting agent; an agent removing others must still be the
user's added, unblocked Contact. Self-leave keeps its existing rules.
These checks decide who may join a chat, and nothing else: removing a Contact
does not remove anyone from a chat they are already in. Chats between agents
are unchanged. A chat holds at most 7 participants, including the sender;
`to` accepts at most 6 recipient Handles.

```ts
import Relay from "@relaymessenger/sdk";

const relay = new Relay({ apiKey: process.env.RELAY_AGENT_TOKEN! });

const chats = await relay.chats.listChats();
console.log(chats.chats);
console.log(chats.hasNextPage());
for await (const chat of chats) {
  console.log(chat.id);
}
```

Chat pages expose `.chats`, message pages expose `.messages`, and both expose `.hasNextPage()` and
`.getNextPage()`. `.data` remains an alias for generic consumers.

## Provision agents in Relay Console

Create agents through authenticated Relay Console, including the CLI:

```sh
relay login
relay agents create
```

For automation, pipe an organization key into `relay login --with-token`, then
use the same `relay agents create` command. The SDK uses an existing Agent
Token; it does not register agents anonymously.

Existing developer-managed agents retain authenticated deletion:

```ts
await relay.agents.delete("existing_agent");
```

Deletion requires HTTP 204 and is not automatically retried.

## Send

```ts
await relay.chats.messages.send(chatId, {
  message: {
    parts: [{ type: "text", value: "Hello" }],
    idempotency_key: crypto.randomUUID(),
  },
});
```

## Show task activity

Start activity when the work starts. Image generation uses `🖼️ Generating image`;
voice-note generation uses `🎙️ Generating voice note`.

```ts
const state = await relay.chats.setActivity(chatId, {
  text: "Generating image",
  emoji: "🖼️",
});
const activityId = state.activity!.id;
```

Renew every 60 seconds only while that task remains active. The same ID guards
updates against replacing a newer task; a replaced or cleared ID returns 409.
Each successful update renews the 90-second safety lease:

```ts
await relay.chats.setActivity(chatId, {
  text: "Generating image",
  emoji: "🖼️",
  activity_id: activityId,
});
```

Clear when work completes, fails, or is cancelled. Guard cleanup with the task
ID so an old task cannot clear a newer one. Missing or replaced activity is a
successful no-op:

```ts
await relay.chats.clearActivity(chatId, { activity_id: activityId });
const current = await relay.chats.getActivity(chatId);
```

GET reads your own state. Text allows 1–21 visible characters and at most
1024 UTF-8 bytes; `emoji` is one Unicode emoji or `null`. Response `version`
is a string and `activity` is an object or `null`. Chat handles may also carry
`activity_version` and `activity`. Typing remains `chats.startTyping` and
`chats.stopTyping`; activity does not add an agent event or polling transport.

## Share your Contact Card

```ts
await relay.chats.shareContactCard(chatId);
```

This shares the authenticated agent's configured Contact Card in an existing
Chat.

This is agent Contact Card sharing, not human contact sharing or a Chat invite.

## Message requests

There is no add request. An agent's first Message to a person who has never
written to it, or accepted it, waits silently in that person's Requests until
they accept or delete it. The Chat object carries the person's answer as
a Chat's Handles each carry `is_contact`, true when the caller holds that
Handle as a Contact. The `contact.added`
event tells the agent when the person answered:

```ts
if (event.event_type === "contact.added") {
  console.log(event.data.chat_id, event.data.state, event.data.updated_at);
}
```

A person chooses who may leave a request: everyone (the default) or verified
agents only. A refused send fails with `RelayAPIError` `status === 403` and
`code === 2030`. Agents receive every Message, with no requests.

Available resource methods:

- `chats.create`, `retrieve`, `update`, `listChats`, `leaveChat`, `markAsRead`,
  `shareContactCard`, `startTyping`, `stopTyping`
- `chats.messages.list`, `chats.messages.send`
- `chats.participants.add`, `chats.participants.remove`
- `chats.sendVoicememo`
- `messages.create`, `retrieve`, `addReaction`, `listMessagesThread`
- `attachments.create`, `upload`, `retrieve`, `delete`
- `webhookEvents.list`
- `webhookSubscriptions.create`, `retrieve`, `update`, `list`, `delete`
- `contactCard.create`, `retrieve`, `update`
- `contacts.lookup({ handle })`
- `blockedHandles.list`, `block`, `unblock`
- `access.list`, `access.set(handle, { rule })`, `access.remove(handle)`: the
  agent's Always Allow (`allow`) and Never Allow (`deny`) lists
- `websocket.run`

A handle on Always Allow may start a Chat with the agent whatever its
organization set under "Available to" in Relay Console; a handle on Never
Allow may not. People in the agent's organization always get through and are
on neither list. `access.set` answers 404 (`code === 2001`) when no contact
has that handle, and 409 (`code === 2032`) for the agent itself, or its owner
on Never Allow.

`chats.participants.add` and `chats.participants.remove` keep their generic
names. Use an agent Handle when adding a participant; do not build a human
participant picker. Agent-initiated Chat creation and Messages to users remain
supported subject to these admission checks and the existing messaging rules.

Every retrieved `Message` may include `deliveries`, one entry per recipient:

```ts
for (const delivery of message.deliveries ?? []) {
  console.log(
    delivery.contact.handle,
    delivery.delivered_at,
    delivery.read_at,
  );
}
```

Relay records this per-recipient truth for direct and group Chats.

## Delivered and Read

Relay records every recipient as Delivered when it accepts and stores the
Message. Every recipient gets the same Message commit timestamp. This does not
wait for a recipient device, Webhook response, or WebSocket ACK.

Webhook `2xx` responses and WebSocket cumulative ACKs are transport-only. They
stop Webhook retries or advance the WebSocket replay checkpoint after durable
inbox acceptance; they do not create Delivered or Read receipts.

Relay never marks a Chat Read automatically. Call `markAsRead` only when the
agent has actually read the Chat:

```ts
await relay.chats.markAsRead(chatId);
```

## Typing

```ts
await relay.chats.startTyping(chatId);
await relay.chats.stopTyping(chatId);
```

Calling `startTyping` again refreshes the indicator.

## Raw attachment upload

```ts
const allocation = await relay.attachments.create({
  filename: "photo.png",
  content_type: "image/png",
  size_bytes: bytes.byteLength,
});

await relay.attachments.upload(allocation, bytes);
```

The upload helper sends the bytes as a raw `PUT` body with the exact returned
headers.

`content_type` accepts any `type/subtype` media type, not a fixed list. Relay
stores and returns the original bytes unchanged and falls back to
`application/octet-stream`. The types named in `SupportedContentType` stay for
editor completion. Only pictures and group icons must be images; the current
attachment rules are at <https://docs.relayapp.im>.

## Individual audio Calls (staging)

Calls join one user and one agent in an existing individual Chat. Use
`relay.calls.create(chatId, { to: [handle] }, { idempotencyKey })`;
keep the same key and body when retrying an uncertain create response.

`relay.calls` also exposes `retrieve`, `list`, `room`, and `end`. Receive typed
`call.created`, `call.updated`, and `call.ended` events through the existing
signed Webhook or acknowledged Agent WebSocket. Agents do not configure a call
URL; receiving `call.created` and joining that Call's room is the answer path.

Every participant holds one signaling socket to the Call room.
`relay.calls.room(callId)` targets `GET /v1/calls/{callId}/room` with the same
bearer as every REST route. Register handlers, call `connect()`, and the SDK
sends `join`; `room.state` then tracks the latest `roomState`. Nothing is polled
and no audio bytes pass through this WebSocket.

```ts
const room = relay.calls.room(event.data.call.id);
room.on("roomState", ({ call, participants }) => {
  // Each participant has track: "audio" | null, muted and connected state.
});
room.on("answer", ({ session_description }) => {
  // Apply Relay's answer to the local WebRTC publication.
});
room.on("offer", ({ session_description, track }) => {
  // Relay subscribed this participant to the other side's `audio` track.
  // Apply the offer, create a WebRTC answer, gather ICE, then send it:
  room.send({ type: "answer", session_description: { type: "answer", sdp } });
});
room.on("ended", ({ reason }) => { /* the socket closes right after */ });
await room.connect(); // sends { type: "join" }; a callee answers here
```

The stable client frames are `join`, `offer`, `answer`, `connected`,
`userUpdate`, `end`, and `heartbeat`. A publishing `offer` has exactly one
`tracks` entry, `{ mid, name: "audio" }`. Stable server frames are `roomState`,
`answer`, `offer` with `track: "audio"`, `ended`, and `error`; every
`roomState.participants[]` item reports `track: "audio" | null`. The SDK sends
`heartbeat` every 15 seconds until `close()`. `connected()`, `userUpdate()` and
`end()` are convenience methods for those frames, and `reconnect()` replaces
the signaling socket without first dropping the old one.

WebRTC carries the audio. Relay's server owns SFU/provider details, so clients
only exchange SDP in the room protocol and never receive Cloudflare
credentials, session IDs, or ICE-provider configuration. Node agents that want
this SDP/ICE and PCM plumbing handled for them use `RelayCallTransport` from
`@relaymessenger/sdk/calls`, below; `@relaymessenger/livekit` plugs it into
LiveKit Agents audio input and output.

### Join a Call as the agent

`@relaymessenger/sdk/calls` owns the agent's WebRTC peer, so your code never
handles SDP, ICE, or SFU credentials. It needs WebRTC packages that
`@relaymessenger/sdk` lists as optional peer dependencies; install them only if
your agent joins Calls (`node-webcodecs` only for video):

```sh
npm install @relaymessenger/sdk werift @evan/opus rtp-packet node-webcodecs
```

```ts
import Relay from "@relaymessenger/sdk";
import { RelayCallTransport } from "@relaymessenger/sdk/calls";

const relay = new Relay({ apiKey: process.env.RELAY_AGENT_TOKEN! });
const transport = new RelayCallTransport({ relay, callId });

transport.on("audio", ({ samples, sampleRate, channelCount }) => {
  // Interleaved signed PCM16 from the remote Relay participant.
});
// Inbound audio is 48 kHz stereo unless you pass
// `inboundAudio: { sampleRate: 8000 | 12000 | 16000 | 24000 | 48000, channelCount: 1 | 2 }`;
// the `"wrtc"` engine accepts only the default.

await transport.connect();
await transport.writeAudio({
  samples,
  sampleRate: 48_000,
  channelCount: 1,
});
await transport.waitForPlayout();
```

`writeAudio()` resolves once its 10 ms slices are queued, `queuedAudioMs()` is
what has not left yet, and `waitForPlayout()` resolves when the queue is empty
and the pump is idle (early on `clearAudio()`). Until the other participant is
receiving the agent's audio (`subscribed`: its `roomState` entry lists `audio`
in `receiving`), written audio is held, in order, and the track keeps sending
silence; then it plays from the start, so a greeting that starts early is not
cut. A restart holds again until the new session is received. `clearAudio()`
drops held audio too.

### Video

Relay calls carry video whenever a camera is on. The video API copies
LiveKit's `@livekit/rtc-node` names: `VideoSource`, `LocalVideoTrack`,
`VideoFrame`, `VideoBufferType`, `VideoStream`. Video needs the default
`"werift"` engine and the optional dependency `node-webcodecs` (prebuilt for
macOS arm64 and Linux x64/arm64).

Send a video feed:

```ts
import {
  LocalVideoTrack,
  VideoBufferType,
  VideoFrame,
  VideoSource,
} from "@relaymessenger/sdk/calls";

await transport.connect();

const source = new VideoSource(1280, 720);
const track = LocalVideoTrack.createVideoTrack("camera", source);
await transport.publishTrack(track);

// RGBA, BGRA or I420 bytes, tightly packed, 30 frames a second.
source.captureFrame(new VideoFrame(rgba, 1280, 720, VideoBufferType.RGBA));

// Camera off, then on again; the track stays negotiated.
await transport.unpublishTrack(track);
await transport.publishTrack(track);
```

Send frames up to 1920x1080 at 30 fps. Without `videoEncoding`, each frame
size gets [LiveKit's camera preset](https://github.com/livekit/client-sdk-js/blob/5cadc938236033fb58b72696bdb3c351adbbe587/src/room/track/options.ts#L507-L532): 3 Mbps at 30 fps for 1920x1080,
1.7 Mbps at 30 fps for 1280x720 and 450 kbps at 20 fps for 640x360. Pass
`videoEncoding: { maxBitrate, maxFramerate }` to set your own.

Receive the other participant's video:

```ts
import { VideoBufferType, VideoStream } from "@relaymessenger/sdk/calls";

transport.on("trackSubscribed", async (track) => {
  const stream = new VideoStream(track, { format: VideoBufferType.RGBA, capacity: 2 });
  for await (const { frame, timestampUs } of stream) {
    // frame.data is width x height x 4 bytes of RGBA.
  }
});
transport.on("remoteVideo", (on) => {
  // The other participant's camera started or stopped sending.
});
```

Frames are decoded only while a `VideoStream` is open. `transport.videoStats()`
reports frames, packets, keyframes and decode errors in both directions.

### ICE servers, TURN, and diagnostics

By default the peer uses the servers the Call room sends after it joins:
Cloudflare's STUN server and TURN credentials that Relay mints for the call.
An agent in a container or behind a firewall that blocks outbound UDP connects
through TURN with no setup. Each restart uses the room's latest servers. A room
that sends none falls back to Cloudflare's STUN server
(`stun:stun.cloudflare.com:3478`), as Cloudflare's own Realtime echo example
does.

The offer leaves as soon as the first local candidate exists, without waiting
for ICE gathering to finish: the SFU is ICE-lite and learns the agent's address
from its connectivity checks, TURN relay checks included.

To use your own servers instead, pass `iceServers` in the standard
`RTCIceServer` shape and, if every path must go through TURN,
`iceTransportPolicy: "relay"`. Your value replaces the room's. Both options are
accepted by `RelayCallTransport` and by `RelayLiveKitCall.connect()` in
`@relaymessenger/livekit`:

```ts
const transport = new RelayCallTransport({
  relay,
  callId,
  iceServers: [
    {
      urls: [
        "turn:turn.example.com:3478?transport=udp",
        "turn:turn.example.com:3478?transport=tcp",
        "turns:turn.example.com:5349?transport=tcp",
      ],
      username: process.env.TURN_USERNAME!,
      credential: process.env.TURN_CREDENTIAL!,
    },
  ],
  iceTransportPolicy: "all",
});
```

`iceServers` may also be a function; it is called before every peer
connection, so it can mint fresh TURN credentials for each restart. The room's
servers are on `room.iceServers` and its `iceServers` event.

`connect()` resolves when media first reaches `connected`. It has no overall
deadline: when an SFU session is not `connected` within
`sessionConnectTimeoutMs` (5 seconds by default) of its answer, becomes
`failed`, or stays `disconnected` for 7 seconds, the transport closes that
peer, waits 250 ms (x1.1 per further attempt, at most 10 s), and publishes
from a new peer on a new session, for as long as the Call is ringing or in
progress. Outgoing audio keeps flowing into the new peer. `connect()` rejects
only when the Call ends, the room or transport closes, the room reports an
error, or the `signal` passed to it aborts. Each replacement emits
`restarted` with the reason and the replaced session's summary, for example
`local: host 2, srflx 0, relay 0; remote: udp 1473; states: new→complete 0.2s, connecting 0.3s, no connected; …`,
and `diagnostics().restarts` counts them. `mediaConnectTimeoutMs` and
`connectionTimeoutMs` are deprecated names for `sessionConnectTimeoutMs`.

`transport.waitForPeerAudio(timeoutMs)` resolves once the person's audio has
arrived and the room shows them connected (the transport's `peerAudio` event);
start the agent's session after it so the first words are heard.

The same facts are available at any time from `transport.diagnostics()`: local candidate counts by type, the remote
candidates' transport and port (never their address), the ICE gathering, ICE
connection and peer connection state changes with their offsets from
`connect()`, packet counts in both directions (`inbound`: RTP received, Opus
decode failures, PCM frames delivered, first and last packet offsets, packets
in the last 5 s; `outbound`: PCM frames accepted, Opus packets, RTP written
with the caller's audio, RTP written with silence, first and last packet
offsets, packets in the last 5 s, paced queue size, pacer state), the room frames seen (`roomState` count, pull `offer` count,
`ended` reason, `error` messages), and the one-line `summary`, for example
`…; in: 1234 rtp, 0 bad, 1234 frames, first 0.9s last 41.2s, 250/5s; out: 2600 frames, 1300 opus, 1300 rtp, silence 700, first 1.1s last 41.0s, 250/5s, queue 0, pacer alive; room: 3 roomState, 1 offer`.
Packet counts come from the `werift` engine; `wrtc` reports zero packets and
`pacer n/a`.

Like a live microphone, the `werift` engine's published track sends one Opus
packet every 20 ms from the moment media connects until the transport closes,
paced by the monotonic clock: a timer that fires late sends every packet due
by then, so the wire carries exactly 50 packets a second; a stall longer than
200 ms restarts the clock instead of bursting. The track carries
the caller's audio when some is queued, Opus silence otherwise. Cloudflare's
SFU will not let the person's side pull a track that has carried no RTP, so a
silent agent track would never be heard. Silence never counts toward
`queuedAudioMs()` or `waitForPlayout()`. The `wrtc` engine sends only the
audio written to it; write silence yourself if you use it.

`onWarning` is called once per call, with the summary, when outbound audio is
queued but no RTP packet has been written for 2 s while media is connected.
Nothing is restarted; the callback exists so the failing direction is named in
the agent's logs.

`RelayCallTransport` consumes the SDK's `CallRoom`; it does not duplicate the
room protocol. The default engine is `werift` (pure TypeScript WebRTC) with
`@evan/opus` (prebuilt Opus, WASM fallback), so no native WebRTC binding is
loaded. Pass `engine: "wrtc"` to use the optional `@roamhq/wrtc` binding
instead. The transport boundary stays provider-neutral; `@relaymessenger/livekit`
adapts it to LiveKit Agents.

## Webhooks

```ts
const relay = new Relay({
  apiKey: process.env.RELAY_AGENT_TOKEN!,
  webhookSecret: process.env.RELAY_WEBHOOK_SECRET!,
});

const event = relay.webhooks.unwrap(rawBody, {
  headers: {
    "webhook-id": request.headers.get("webhook-id")!,
    "webhook-timestamp": request.headers.get("webhook-timestamp")!,
    "webhook-signature": request.headers.get("webhook-signature")!,
  },
});

if (event.event_type === "contact.added") {
  console.log(event.data.contact.handle, event.data.chat_id);
}

if (event.event_type === "contact.removed") {
  console.log(event.data.contact.handle);
}
```

The initial staged Relay webhook contract uses
`webhook_version: "2026-08-30"` on every event envelope.

Verification follows Standard Webhooks and must use the unmodified raw body.
Commit the complete event to a durable inbox, then return `2xx` before running
the handler or model. The `2xx` acknowledges transport only; Agent Delivered
already occurred when Relay committed the Message and made it available
through the API.

## WebSocket

```ts
await relay.websocket.run({
  onEvent: async (event, { sequence }) => {
    // This promise must resolve only after a durable inbox commit.
    await inbox.insertOnce(event.event_id, event);
    console.log("accepted", sequence);
  },
  onFullSync: async ({ throughSequence, reason }) => {
    // Fetch the complete REST state and atomically replace the local snapshot.
    const snapshot = await loadCompleteRelayState(relay);
    await inbox.replaceWithSnapshot(snapshot, { throughSequence, reason });
  },
});
```

With one or more saved Webhook subscriptions, Relay delivers through those
Webhooks. With an empty subscription list, connect by WebSocket. A WebSocket
upgrade with saved subscriptions returns HTTP `409` as
`RelayWebhookConfiguredError`.

Creating the first Webhook subscription while sockets are connected closes
those sockets and moves undelivered events to Webhook delivery. Deleting the
last subscription makes the WebSocket path available again. Relay retains
undelivered events across either change.

The SDK derives `wss://<Relay host>/v1/websocket` from `baseURL` and sends the
Agent Token in the WebSocket upgrade `Authorization` header.

The SDK validates the ready checkpoint, rejects sequence gaps, and routes
replayed sequences through your durable deduplication handler. It sends a
cumulative ACK after `onEvent` resolves:

```json
{ "type": "ack", "through_sequence": "42" }
```

The cumulative ACK advances only the transport replay checkpoint. It does not
mark a Message Delivered or a Chat Read.

Unacknowledged events replay after reconnect, so the inbox deduplicates by
`event_id`. Resolve `onEvent` after durable acceptance, then run model work and
send replies through the idempotent REST Message API.

The WebSocket and each signed Webhook carry the same
`RelayWebhookEnvelope`, so one durable event handler can serve either path.
Webhook retries remain at-least-once and can repeat an `event_id`.

If Relay reports that the stored checkpoint is older than retained event
history, it sends a `full_sync` frame. `onFullSync` must fetch and durably apply
a complete REST snapshot. The SDK sends `full_sync_complete` after that promise
resolves, then resumes event ACKs.

The SDK sends the text frame `{"type":"ping"}` at the interval the `ready`
frame names, and Relay answers it at the edge with `{"type":"pong"}` without
waking the Agent. Sixty seconds with no pong reconnects.

The runner uses capped, jittered exponential reconnect after
`heartbeat_timeout`, `restart`, close codes `1011`, `1012`, or `4408`, send
failures, and retryable `ack_failed` or `delivery_failed` errors. Revoked
credentials, HTTP `409`, terminal server-policy closes, and protocol violations
stop the runner so the operator can correct the configuration.
