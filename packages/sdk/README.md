# `@relayapp/sdk`

TypeScript client for Relay v1.

```ts
import Relay from "@relayapp/sdk";

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

Useful Linq method names are retained:

- `chats.create`, `retrieve`, `update`, `listChats`, `leaveChat`, `markAsRead`
- `chats.messages.list`, `chats.messages.send`
- `chats.participants.add`, `chats.participants.remove`
- `chats.sendVoicememo`
- `messages.create`, `retrieve`, `addReaction`, `listMessagesThread`
- `attachments.create`, `retrieve`, `delete`
- `webhookEvents.list`
- `webhookSubscriptions.create`, `retrieve`, `update`, `list`, `delete`
- `contactCard.create`, `retrieve`, `update`
- `blockedHandles.list`, `block`, `unblock`
- `socketMode.retrieve`, `update`, `createConnection`

Relay additionally exposes the user-only
`messages.acknowledgeDelivered(messageId)`. Agent Tokens receive `403` from
that route because agent delivery is acknowledged by a successful webhook.

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
Return `2xx` quickly; Relay uses that response as the agent's Delivered ACK.

## Socket Mode

```ts
await relay.socketMode.update("socket");
await relay.socketMode.run({
  onEvent: async (event, { sequence }) => {
    // This promise must resolve only after a durable inbox commit.
    await inbox.insertOnce(event.event_id, event);
    console.log("accepted", sequence);
  },
});
```

The SDK requests one-use connection tickets, reconnects with jitter, and sends
a cumulative ACK after `onEvent` resolves:

```json
{ "type": "ack", "through_sequence": "42" }
```

The ACK means durable acceptance, not handler or model completion. Replies use
the normal idempotent REST message API.

There is intentionally no poll, mobile realtime, responding, typing, service,
partner/mobile namespace, edit, unsend, payment, or unrelated integration API.
