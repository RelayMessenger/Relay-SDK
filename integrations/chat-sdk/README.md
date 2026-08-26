# @relaymessenger/chat-sdk-adapter

Relay adapter for the [Vercel Chat SDK](https://chat-sdk.dev). Relay is a
consumer messenger where people talk to agents the way they talk to contacts;
this package makes a Relay conversation a Chat SDK thread, so anything built on
the Chat SDK can reach Relay users. Raw HTTPS remains the canonical contract;
this is a thin, dependency-free binding of it.

```ts
import { createMemoryState } from "@chat-adapter/state-memory";
import { createRelayAdapter } from "@relaymessenger/chat-sdk-adapter";
import { Chat } from "chat";

const chat = new Chat({
  userName: "My Agent",
  adapters: {
    relay: createRelayAdapter({
      token: process.env.RELAY_AGENT_TOKEN!,
      webhookSecret: process.env.RELAY_WEBHOOK_SECRET!,
    }),
  },
  state: createMemoryState(),
});

chat.onNewMention(async (thread, message) => {
  await thread.subscribe();
  await thread.post({ markdown: `You said: ${message.text}` });
});

// Mount as a POST route.
export const POST = (request: Request) => chat.webhooks.relay(request);
```

`chat` is a peer dependency: install it alongside this package.

## With eve

eve's Chat SDK channel bridges any adapter to an agent. See
[`examples/eve`](../../examples/eve) in this repository for the channel file and
the environment it needs.

## What the adapter enforces

- Standard Webhooks signature verification over the exact raw body, then
  `event_id` deduplication, because Relay delivers at least once. The event id
  is claimed before the handler runs, so two redeliveries racing each other
  cannot both dispatch, and released again if the handler throws, so Relay's
  retry of a failed turn is still handled. **This window is a bounded set in
  memory, in one process.** A restart, or a second instance behind the same
  webhook URL, has no claim to lose and will dispatch the event again. The
  message id below is what makes that second dispatch harmless.
- A client-minted `msg_` ULID on every `POST /v1/messages`. That id is the
  message's identity and the send's only retry key: Relay replays a send
  carrying an id it already committed rather than committing it twice, and
  refuses another sender's claim on one with 409. There is no
  `Idempotency-Key` header. Pass `messageId` to `client.send` to reuse an id
  across your own retries; the adapter mints a fresh one per call, so a
  re-post after a failure is a deliberate second message rather than a silent
  replay.
- Chunking rather than truncation. Relay caps a text part at 8 KB and a message
  at 32 parts; a longer reply becomes more parts. Each text part draws as its
  own balloon in the app, so a long reply arrives as a stack of bubbles rather
  than one tall one. A split consumes the whitespace it lands on, and nothing
  else. One send is one message — past 32 parts the adapter posts follow-up
  messages, which is its own choice and not a server split.

## Formatting

Relay does not render Markdown. A text part carries canonical plain text plus
`styles` runs with UTF-16 offsets, and clients draw the runs. So `{ markdown }`
and `{ ast }` are flattened to the text a person reads, with emphasis carried
across as style ranges: `strong` becomes `bold`, `emphasis` becomes `italic`,
and `delete` becomes `strikethrough`. Relay's whole style set is
`bold | italic | underline | strikethrough`.

Constructs Relay has no style for keep their information in the text rather than
losing it. A link whose label differs from its target renders as `label (url)`,
a blockquote keeps its `> ` line prefix, a list keeps its markers, and a table is
drawn as an ASCII grid whose alignment lives in the characters. Code is the same
case: none of Relay's four styles is fixed width, so inline and fenced code keep
their characters verbatim and take no style run rather than wearing a decoration
the author never wrote. A plain string is sent verbatim with an empty
`styles` array, which is Relay's marker for structured plain text rather than a
legacy Markdown body.

## Capabilities

| Chat SDK operation                 | Relay                                                              |
| ---------------------------------- | ------------------------------------------------------------------ |
| `postMessage`                      | `POST /v1/messages`                                                |
| `addReaction`, `removeReaction`    | `POST /v1/messages/{id}/reactions`                                 |
| `startTyping`, `stopTyping`        | `POST /v1/conversations/{id}/typing`, ephemeral `{ started }`      |
| `markAsRead`                       | `POST /v1/conversations/{id}/read`                                 |
| `fetchMessages`, `fetchThread`     | `GET /v1/conversations/{id}/messages` and `/v1/conversations/{id}` |
| `getUser`                          | `GET /v1/users/{id}`, scoped to a shared conversation              |
| `stream`                           | Buffered, then committed as one message                            |
| `editMessage`, `deleteMessage`     | Not implemented: Relay message content is immutable                |

Things Relay does not do, stated rather than faked:

- **No streaming bubbles.** A turn commits exactly one canonical message, so
  `stream` buffers the whole reply and posts it once. Nothing partial reaches a
  recipient. With eve's Chat SDK channel, set `streaming: false`.
- **No edits and no unsend.** Message content is immutable: no revisions, no
  version, no tombstone. `editMessage` and `deleteMessage` throw
  `NotImplementedError` rather than quietly posting a second message.
- **No forward history cursor.** `GET /v1/conversations/{id}/messages` pages
  backwards with `before_sequence`, so `fetchMessages({ direction: "forward" })`
  throws `NotImplementedError` instead of walking the whole conversation.
- **No single-message read.** The API has no `GET /v1/messages/{id}`, so
  `fetchMessage` is not implemented and the Chat SDK returns `null`.
- **No cards.** Relay removed interactive components. A card is delivered as its
  fallback text, so the words arrive but buttons do not render and a
  human-in-the-loop prompt cannot be answered in the app.
- **No typing label.** Relay's typing route carries a `started` flag and nothing
  else, so the Chat SDK's `status` argument is accepted and dropped.

Attachments work in both directions. Inbound media and voice memo parts arrive as
Chat SDK attachments; outbound attachments with a public HTTPS URL are sent as
media parts, and outbound bytes are uploaded through `POST /v1/attachments`
first.

Docs: <https://docs.relayapp.im>.
