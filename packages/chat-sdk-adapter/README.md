# @relaymessenger/chat-sdk-adapter

Vendor-official Relay adapter for
[Vercel Chat SDK](https://chat-sdk.dev), targeting `chat@4.39.0`.

Source is maintained in
[`RelayMessenger/Relay-SDK`](https://github.com/RelayMessenger/Relay-SDK/tree/main/packages/chat-sdk-adapter)
under `packages/chat-sdk-adapter`.

Relay Chats map one-to-one to Chat SDK threads. Provider thread IDs are stable
`relay:<chat UUID>` values; provider message IDs are bare Relay Message UUIDs.

## Install

```sh
npm install chat@4.39.0 @chat-adapter/state-memory@4.39.0 \
  @relaymessenger/chat-sdk-adapter
```

## Minimal use

```ts
import { createMemoryState } from "@chat-adapter/state-memory";
import { createRelayAdapter } from "@relaymessenger/chat-sdk-adapter";
import { Chat } from "chat";

const chat = new Chat({
  userName: "My Relay Agent",
  adapters: {
    relay: createRelayAdapter({
      token: process.env.RELAY_AGENT_TOKEN,
      webhookSecret: process.env.RELAY_WEBHOOK_SECRET,
    }),
  },
  state: createMemoryState(),
});

chat.onNewMention(async (thread, message) => {
  await thread.subscribe();
  await thread.post(`You said: ${message.text}`);
});

// Mount this on the Relay webhook URL.
export const POST = (request: Request) => chat.webhooks.relay(request);
```

An executable Node HTTP example is in [`examples/server.mjs`](examples/server.mjs).

## Factory API

```ts
type RelayCredential =
  | string
  | (() => string | Promise<string>);

interface RelayAdapterOptions {
  token?: RelayCredential;          // RELAY_AGENT_TOKEN fallback
  webhookSecret?: RelayCredential;  // RELAY_WEBHOOK_SECRET fallback
  typing?: boolean;                 // default true
  userName?: string;                // default "Relay Agent"
  agentId?: string;                 // this agent's Relay Contact UUID
  baseUrl?: string;                 // default https://api.relayapp.im
  fetch?: typeof fetch;
  client?: RelayClient;
  signatureToleranceSeconds?: number; // default 300
  idempotencyKeyResolver?: (context: {
    chatId: string;
    threadId: string;
    parts: readonly RelayOutgoingPart[];
    replyToMessageId?: string;
  }) => string | Promise<string>;
}

createRelayAdapter(options?: RelayAdapterOptions): RelayAdapter;
```

Credential functions satisfy Vercel's vendor-official non-static credential
requirement. The token resolver is called for every Relay API request. The
webhook-secret resolver is called for every webhook delivery. Values are not
cached.

Every send caused by an inbound webhook carries
`Idempotency-Key: relay-chat-sdk:<event_id>:<send ordinal>`. A redelivery starts
at ordinal zero again, so the same event/body replays while changed recovery
content reaches Relay under the same key and receives the contract's 409
`idempotency_conflict`. This context uses `AsyncLocalStorage` only for the
active turn and is never persisted.

Posts made outside an inbound webhook have no Relay `event_id`. The adapter
therefore requires `idempotencyKeyResolver` for those non-empty posts rather
than manufacturing a random key that changes on recovery. Think integrations
should return their stable Action/delivery identity from this resolver.

### Think runtime typing

For a runtime that owns typing timing, disable Chat SDK surface typing:

```ts
const relay = createRelayAdapter({
  token,
  webhookSecret,
  typing: false,
});
```

With `typing: false`, both `startTyping()` and `endTyping()` validate the thread
ID but make no Relay request. This prevents Think's pre-inference
`ChatThread.startTyping()` from surfacing. Other adapter instances default to
normal `POST`/`DELETE /v1/chats/{chatId}/typing` support.

## Locked contract

This package was rewritten against:

- Relay Server `f6e96c7520c301f04ab2182a85a961cf05c4ed07`
- OpenAPI SHA-256
  `86163217bb7273d7d438d9861fb4456978df587d941e5803c97e43eb1ee00682`
- public `ChatHandle.image_url` and `ChatHandle.about` fields, with no legacy
  aliases
- Relay API `v1`
- Relay webhook payload version `2026-08-30`
- `chat@4.39.0`

The byte-identical Server OpenAPI copy is retained under `contracts/` for
reproducible contract tests and is excluded from the npm package.

## Supported surface

| Chat SDK operation | Locked Relay v1 operation |
| --- | --- |
| `postMessage`, `postChannelMessage` | `POST /v1/chats/{chatId}/messages` |
| `reply` | Same route with `message.reply_to` |
| `stream` | Buffered, then one canonical Message; never partial bubbles |
| outbound public-URL media | Message `media` part |
| outbound bytes/files | Explicitly allocate/upload with `@relaymessenger/sdk`, then post a stable public HTTPS URL |
| inbound media | Chat SDK `Attachment` with `fetchData()` |
| `addReaction`, `removeReaction` | `POST /v1/messages/{messageId}/reactions` |
| `startTyping`, `endTyping` | `POST`/`DELETE /v1/chats/{chatId}/typing` |
| `markAsRead` | `POST /v1/chats/{chatId}/read` |
| `fetchMessages({ direction: "forward" })` | `GET /v1/chats/{chatId}/messages` |
| `fetchMessage` | `GET /v1/messages/{messageId}` |
| `fetchThread`, `fetchChannelInfo` | `GET /v1/chats/{chatId}` |

### Inbound attachments

An inbound Relay media part becomes a Chat SDK `Attachment` carrying
`url`, `mimeType`, `name`, `size`, `type`, `width`, `height`, and a
`fetchData()` that resolves to the bytes as an `ArrayBuffer`. Nothing is
downloaded until you call it.

```ts
for (const attachment of message.attachments) {
  const bytes = await attachment.fetchData?.();
}
```

**A Relay download URL expires 60 minutes after Relay minted it.** The URL is a
sealed, unauthenticated download capability, so `fetchData()` sends no Agent
Token; after that window the download fails with `RelayApiError` HTTP 404.

That expiry is not a limit on queued work. `Message.toJSON()` drops
`fetchData`, so queue and debounce strategies call `rehydrateAttachment()` to
rebuild it — and the rebuilt closure calls `GET /v1/attachments/{attachmentId}`
first, which mints a new 60-minute download link on every request. A Message may
sit in a queue for as long as you like and still read its bytes. The serialized
URL is kept in `fetchMetadata` only as the fallback for an attachment whose
metadata predates this behavior.

`GET /v1/attachments/{attachmentId}` authorizes any Chat participant who could
read the Message, so an agent reads the attachments of messages sent to it
without owning them.

Relay text parts are plain text and are limited to 10,000 UTF-16 code units.
Long Chat SDK text is split without breaking surrogate pairs. A Relay Message
is limited to 100 parts. A public HTTPS attachment URL is sent directly.
Automatic byte/file uploads are rejected because a fresh Attachment allocation
would change the Message body after an ambiguous send. Allocate and upload with
`@relaymessenger/sdk`, retain that prepared identity durably, then give this
adapter the stable HTTPS URL.

Think's `thread.post(callback.stream())` path is safe when the stream is empty:
the adapter returns a local no-op result so Chat SDK does not enter its
post-then-edit fallback. Non-empty streams are fully buffered and committed in
one request. Empty string posts are the same no-op. No partial or placeholder
Message reaches Relay.

## Explicitly unsupported

The adapter throws Chat SDK `NotImplementedError` rather than calling an
undocumented route for:

- message editing and deletion;
- editable drafts or partial streaming bubbles;
- open-only direct messages;
- public Contact lookup;
- backward history pagination.

Relay's locked chat-history cursor advances oldest-to-newest. It cannot satisfy
Chat SDK's backward-cursor semantics, so callers must request
`direction: "forward"` explicitly.

Cards have no Relay interaction surface. Their fallback text is sent; a card
without text is rejected.

## Webhooks

The adapter internally verifies current signed Standard Webhooks over the exact
raw body:

```text
HMAC-SHA256(secret, "${webhook-id}.${webhook-timestamp}.${rawBody}")
```

Every valid current event type is acknowledged. `message.received` is
dispatched to Chat SDK message handlers, and non-self `reaction.added` /
`reaction.removed` events are dispatched to reaction handlers. Receipt,
participant, Chat metadata, typing, and Contact events have no matching Chat
SDK inbound hook and are acknowledged without fabricated behavior.

Direct Chats route through Chat SDK's direct-message path and do not need an
`isMention` flag. In a group, `isMention` is true only when a canonical text
part's `mention` equals the receiving Chat `owner_handle`; when `agentId` is
configured, the owner UUID must match it.

This package adds no persistence and no adapter-owned delivery-idempotency
store. Think Actions remain the delivery-idempotency owner outside webhook
turns. `RelayClient.sendMessage()` requires an explicit idempotency key.

## Development

```sh
npm ci
npm run check
npm run build
npm run test:unit
npm run test:workerd
npm run test:installed
```

`@chat-adapter/shared@4.39.0` provides shared adapter utilities and errors. That
published package has no `/tests` export; Vercel's published contract runner is
`@chat-adapter/tests@4.39.0`, which this package uses alongside
`@chat-adapter/shared`.
