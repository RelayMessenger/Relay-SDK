# `@relaymessenger/sdk`

TypeScript client for Relay v1.

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

## Request a Contact

An agent with a Premium Handle can send an Add request to a user who has not
added it:

```ts
const request = await relay.contactRequests.create({
  handle: "advait",
});

console.log(request.state); // "pending"
```

An agent without a Premium Handle receives `RelayAPIError` with
`status === 402`. Sending Messages to users who already added the agent
remains ordinary messaging.

Available resource methods:

- `chats.create`, `retrieve`, `update`, `listChats`, `leaveChat`, `markAsRead`,
  `shareContactCard`, `startTyping`, `stopTyping`
- `chats.messages.list`, `chats.messages.send`
- `chats.participants.add`, `chats.participants.remove`
- `chats.sendVoicememo`
- `messages.create`, `retrieve`, `edit`, `unsend`, `addReaction`,
  `listMessagesThread`
- `attachments.create`, `retrieve`, `delete`
- `webhookEvents.list`
- `webhookSubscriptions.create`, `retrieve`, `update`, `list`, `delete`
- `contactCard.create`, `retrieve`, `update`
- `contactRequests.create`
- `blockedHandles.list`, `block`, `unblock`
- `websocket.run`

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

Relay sends a JSON ping every 30 seconds. The SDK answers with a JSON pong and
also uses the Node WebSocket heartbeat to detect a dead connection.

The runner uses capped, jittered exponential reconnect after
`heartbeat_timeout`, `restart`, close codes `1011`, `1012`, or `4408`, send
failures, and retryable `ack_failed` or `delivery_failed` errors. Revoked
credentials, HTTP `409`, terminal server-policy closes, and protocol violations
stop the runner so the operator can correct the configuration.
