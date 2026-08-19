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
  idempotency key below is what makes that second dispatch harmless.
- A deterministic `Idempotency-Key` on every `POST /v1/messages`, derived from
  the inbound event id and the send's position in the turn, and from nothing
  else. Relay hashes the request body server side and stores it beside the key,
  so a retry carrying the same body replays the first response and a retry
  carrying a different body is refused with 409 `idempotency_conflict`. Keeping
  the content out of the key is what leaves both of those reachable: a key that
  moved with the body would make every retry a new send, and a handler backed
  by a model rarely writes the same words twice.
- Group `invocation_id` threading. Relay delivers a group message to an agent
  only when that agent was invoked, and the reply is scoped to that single-use
  invocation, so the first send of a turn carries it and a second raises
  `RelayInvocationSpentError` rather than going out bare and taking a 403.
- Chunking rather than truncation. Relay caps a text part at 8 KB and a message
  at 32 parts; a longer reply becomes more parts, and then more messages. Each
  text part draws as its own balloon in the app, so a long reply arrives as a
  stack of bubbles rather than one tall one. A split consumes the whitespace it
  lands on, and nothing else.

## Formatting

Relay does not render Markdown. A text part carries canonical plain text plus
`styles` runs with UTF-16 offsets, and clients draw the runs. So `{ markdown }`
and `{ ast }` are flattened to the text a person reads, with emphasis carried
across as style ranges: `strong` becomes `bold`, `emphasis` becomes `italic`,
`delete` becomes `strikethrough`, and inline or fenced code becomes `monospace`.

Constructs Relay has no style for keep their information in the text rather than
losing it. A link whose label differs from its target renders as `label (url)`,
a blockquote keeps its `> ` line prefix, a list keeps its markers, and a table is
drawn as a monospace ASCII grid. A plain string is sent verbatim with an empty
`styles` array, which is Relay's marker for structured plain text rather than a
legacy Markdown body.

## Capabilities

| Chat SDK operation                | Relay                                                            |
| --------------------------------- | ---------------------------------------------------------------- |
| `postMessage`, `editMessage`, `deleteMessage` | `POST /v1/messages`, `PATCH` and `DELETE /v1/messages/{id}` |
| `addReaction`, `removeReaction`    | `POST /v1/messages/{id}/reactions`                              |
| `startTyping`                      | `POST /v1/conversations/{id}/typing`, ephemeral, 80-char label  |
| `markAsRead`                       | `POST /v1/conversations/{id}/read`                              |
| `fetchMessages`, `fetchThread`     | `GET /v1/conversations/{id}/messages` and `/v1/conversations/{id}` |
| `getUser`                          | `GET /v1/users/{id}`, scoped to a shared conversation           |
| `stream`                           | Buffered, then committed as one message                          |

Things Relay does not do, stated rather than faked:

- **No streaming bubbles.** A turn commits exactly one canonical message, so
  `stream` buffers the whole reply and posts it once. Nothing partial reaches a
  recipient. With eve's Chat SDK channel, set `streaming: false`.
- **No forward history cursor.** `GET /v1/conversations/{id}/messages` pages
  backwards with `before_sequence`, so `fetchMessages({ direction: "forward" })`
  throws `NotImplementedError` instead of walking the whole conversation.
- **No agent-initiated DM.** `POST /v1/conversations/direct` accepts a user
  session, not an Agent Token, so `openDM` is not implemented. A conversation
  starts when a person adds the agent.
- **No single-message read.** The API has no `GET /v1/messages/{id}`, so
  `fetchMessage` is not implemented and the Chat SDK returns `null`.
- **No cards.** Relay removed interactive components. A card is delivered as its
  fallback text, so the words arrive but buttons do not render and a
  human-in-the-loop prompt cannot be answered in the app.
- **No edits carrying media.** Relay requires an edit to stay text-bearing and
  rejects attachment parts.

Attachments work in both directions. Inbound media and voice memo parts arrive as
Chat SDK attachments; outbound attachments with a public HTTPS URL are sent as
media parts, and outbound bytes are uploaded through `POST /v1/attachments`
first.

Docs: <https://docs.relayapp.im>.
