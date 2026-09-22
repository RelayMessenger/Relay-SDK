# `@relaymessenger/sdk`

TypeScript client for Relay v1.

## Selection, coming soon

Selection is local, unshipped work. The candidate SDK exposes `SelectionPart`,
`SelectionPartResponse` (including read-only viewer-relative `has_responded`),
and `SelectionResponsePart` through the existing message and event unions.
This is not a claim about the published package or hosted API.

```ts
import { partsWithSelection } from "@relaymessenger/sdk";

const parts = partsWithSelection("Which topics interest you?", {
  type: "selection",
  options: [
    { value: "research", label: "Research" },
    { value: "design", label: "Design" },
  ],
});
// Send with relay.chats.messages.send(chatId, { message: { parts, idempotency_key } }).
```

`selectionPart` validates an options array or complete part, returning a
normalized part or an error string. Options are limited to 25, trimmed labels
to 80 characters, and explicit case-sensitive ASCII token values to 100.
Unknown fields, duplicate values, and blank labels are rejected.
`partsWithSelection` also requires nonblank question text.

Selection inherits existing Chat membership rules: at most one human user,
with multiple agents allowed. Only the human user can respond; agents cannot.
The durable per-user response claim applies across that user's devices and
idempotency keys, without expanding group membership.

`answerMessages` accepts a `selection` fenced JSON block containing the options
array. It keeps invalid blocks as text with an error and never combines a
selection with buttons. Existing buttons retain their behavior.

Tapping a selected option deselects it without sending. The sole submit action
is a centered compact light-blue **Send** button.

The user's new reply is exactly literal `• ` + each selected source label
joined with `\n`, then
`{ type: "selection_response", selected_values: ["research", "design"] }`,
in source-option order, with explicit `reply_to.message_id` and `part_index`.
The user client keeps its existing outgoing idempotency identity for retries.
The server also accepts exact legacy comma-joined source labels only for
compatibility. iOS may present round checked circles, but portable text stays
bulleted. Metadata has no additional display text. Use `selected_values` and the source
reply target to dispatch your own handler, rather than splitting labels.
Signed webhook `unwrap` and WebSocket `onEvent` default types expose this
metadata after narrowing to `message.received`.

Local runtime sources include selection guidance and structured inbound discovery
for CLI, Pi, OpenClaw, the Claude Code channel, MCP, and the Chat SDK adapter.
`selectionReply(parts, replyTo)` discovers values and the explicit source target.
These changes remain unshipped; bundled artifacts and disposable-lane validation
are required before release.

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
- `websocket.run`

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
`relay.calls.create(chatId, { to: [handle], mode: "audio" }, { idempotencyKey })`;
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
this SDP/ICE and PCM plumbing handled for them can use
`@relaymessenger/livekit`, whose provider-neutral `RelayCallTransport` uses a
standards-compatible Node WebRTC binding and whose LiveKit adapter plugs the
result into LiveKit Agents audio input/output.

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
