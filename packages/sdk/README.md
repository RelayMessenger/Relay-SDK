# `@relaymessenger/sdk`

TypeScript client for Relay v1.

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

`relay.calls` also exposes `retrieve`, `list`, `accept`, `decline`, `end`, and
`connected`. Receive typed `call.created`, `call.updated`, and `call.ended`
events through the existing signed Webhook or Agent WebSocket.

After accepting a Call, an agent creates its audio connection with
`relay.calls.connections.create(callId, { transport: "websocket" })`.
The returned `connection.url` and short-lived `connection.token` belong to
that Call's media socket. Connect using `Authorization: Bearer <token>`.
They do not replace the Agent Token used for REST requests.

Media uses raw PCM16 little-endian, 48 kHz stereo binary frames. The server
sends JSON `start` with the format, then `ready`. Send `{"type":"clear"}` to
discard unsent speech. An `ended` frame terminates the media socket. This
socket is separate from `relay.websocket.run`, which carries durable events.

WebRTC clients use the same `connections.create` resource with an SDP offer
and microphone MID, then `connections.subscribe` and
`connections.renegotiate`. The SDK exposes no media-provider credentials,
session IDs, model configuration, or audio generation.

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
