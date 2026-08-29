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

Pagination retains Linq's payload names: chat pages expose `.chats`, message
pages expose `.messages`, and both expose `.hasNextPage()` and
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
Chat. It does not create a Chat.

Useful Linq method names are retained:

- `chats.create`, `retrieve`, `update`, `listChats`, `leaveChat`, `markAsRead`,
  `shareContactCard`, `startTyping`, `stopTyping`
- `chats.messages.list`, `chats.messages.send`
- `chats.participants.add`, `chats.participants.remove`
- `chats.sendVoicememo`
- `messages.create`, `retrieve`, `addReaction`, `listMessagesThread`
- `attachments.create`, `retrieve`, `delete`
- `webhookEvents.list`
- `webhookSubscriptions.create`, `retrieve`, `update`, `list`, `delete`
- `contactCard.create`, `retrieve`, `update`
- `blockedHandles.list`, `block`, `unblock`
- `websocket.retrieve`, `update`, `run`

Relay additionally exposes the user-only
`messages.acknowledgeDelivered(messageId)`. Agent Tokens receive `403` from
that route because agent delivery is acknowledged by a successful webhook or
WebSocket ACK.

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

## Typing

```ts
await relay.chats.startTyping(chatId);
await relay.chats.stopTyping(chatId);
```

Calling `startTyping` again refreshes the indicator. These are real API
commands, not local UI state.

## Raw attachment upload

```ts
const allocation = await relay.attachments.create({
  filename: "photo.png",
  content_type: "image/png",
  size_bytes: bytes.byteLength,
});

await relay.attachments.upload(allocation, bytes);
```

The upload helper sends a raw `PUT` body with the exact returned headers. It
does not JSON-encode or multipart-wrap the bytes.

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
```

Verification follows Standard Webhooks and must use the unmodified raw body.
Commit the complete event to a durable inbox, then return `2xx` before running
the handler or model. Relay uses that response as the agent's Delivered ACK.

## WebSocket

```ts
await relay.websocket.update({ enabled: true });
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

The SDK derives `wss://<Relay host>/v1/websocket` from `baseURL` and sends the
same Agent Token in the WebSocket upgrade `Authorization` header. It does not
create a connection ticket, put credentials in the URL, or request a
subprotocol.

The SDK validates the ready checkpoint and contiguous decimal sequences, then
sends a cumulative ACK only after `onEvent` resolves:

```json
{ "type": "ack", "through_sequence": "42" }
```

Unacknowledged events replay after reconnect, so the inbox must deduplicate by
`event_id`. The ACK means durable acceptance, not handler or model completion.
Replies use the normal idempotent REST message API.

If Relay reports that the stored checkpoint is older than retained event
history, it sends a `full_sync` frame. `onFullSync` must fetch and durably apply
a complete REST snapshot. The SDK sends `full_sync_complete` only after that
promise resolves, and it will not ACK events while FULL sync is pending.

The runner uses capped, jittered exponential reconnect after `heartbeat_timeout`,
`restart`, close codes `1011`, `1012`, or `4408`, send failures, and retryable
`ack_failed`/`delivery_failed` errors. It rejects on `disabled`, `replaced`,
`revoked`, Agent Token rejection, or a protocol violation. Restart it only
after the operator action, credential issue, or contract mismatch is resolved.

There is intentionally no poll, mobile realtime, responding, service,
partner/mobile namespace, edit, unsend, payment, or unrelated integration API.
