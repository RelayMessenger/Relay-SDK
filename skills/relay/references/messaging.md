# Messaging

## Send

Use `POST /v1/messages` to resolve or create a Chat from recipient Handles.
Use `POST /v1/chats/{chatId}/messages` for an existing Chat.

With the TypeScript SDK:

```typescript
import Relay from "@relaymessenger/sdk";

function relayApiOrigin(value?: string): string {
  const url = new URL(value?.trim() || "https://api.relayapp.im");
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (
    url.username || url.password || url.pathname !== "/" || url.search || url.hash
    || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
  ) {
    throw new Error("Relay API origin must be HTTPS; HTTP is loopback-only");
  }
  return url.origin;
}

const relay = new Relay({
  apiKey: process.env.RELAY_AGENT_TOKEN!,
  baseURL: relayApiOrigin(process.env.RELAY_API_URL),
});

// Mint this once for the logical operation and persist it before the request.
const idempotencyKey = savedOperation.idempotencyKey;

await relay.chats.messages.send(chatId, {
  message: {
    parts: [{ type: "text", value: "Hello from Relay." }],
    idempotency_key: idempotencyKey,
  },
});
```

Never mint the key inside a retry attempt. A retry after an unknown outcome
must reuse the exact key and Message body from the prepared operation.

A Message contains ordered `parts`:

- `text` with optional structured `mention` and UTF-16 `mention_range`;
- `media` with exactly one uploaded `attachment_id` or remote `url`;
- `link` with one absolute URL as the only part.

Adjacent text parts are invalid. Replies use `reply_to.message_id` and optional
`reply_to.part_index`.

## Attachments

Allocate with `POST /v1/attachments`, upload raw bytes with the returned method
and required headers, then send the returned Attachment ID as a media part.
The allocation and upload byte length and content type must match. Relay
accepts any `type/subtype` media type and stores the bytes unchanged. Only
pictures and group icons must be images.

Voice memos use the dedicated Chat voice-memo operation after uploading audio.

## Reactions and mentions

Reactions target a Message and part index. Built-in reactions use the named
type; custom reactions also provide `custom_emoji`.

Mentions are group-only structured text-part fields. The mentioned Handle must
be active in the Chat.

## Delivery

`sent`, `delivered`, and `read` are monotonic Message states. Sent is the
client-only handoff state. Relay stores Delivered at server commit and explicit
Read state per recipient.

Delivered means Relay accepted and stored the Message. Every recipient gets
the same commit timestamp. Webhook responses and WebSocket ACKs affect event
transport state, not Message receipts. Relay never marks a Chat Read
automatically; call `relay.chats.markAsRead(chatId)` only when the agent reads
the Chat.

Developers can inspect per-recipient delivery state for direct and group Chats.
