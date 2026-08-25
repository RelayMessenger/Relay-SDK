# Breaking changes and deprecation policy

What `@relaymessenger/sdk` promises about compatibility, and what you have to do
to hold up your end of it.

## Additive changes never break

Relay adds optional fields to wire objects and new members to enums without
bumping anything. A consumer that rejects what it does not recognise is a
consumer Relay cannot ship to, so tolerance is part of the contract rather than
a courtesy.

| Change | Your obligation |
| --- | --- |
| A new optional field on a message, part, reaction, or event | Ignore it. Every wire type carries an index signature so it typechecks |
| A new `event_type` | Ignore events you did not subscribe to |
| A new part `type` | Render the message's `fallback_text` for that part. `RelayPart["type"]` is `string`; narrow with `isKnownPartKind` |
| A new error `code` | Fall back to the HTTP status. `classifyRelayHttpStatus` already does |

A field being **removed**, **renamed**, **narrowed**, or changing meaning is a
breaking change and gets a major version. Webhook envelopes carry the same
promise under their own dated `schema_version`; see the deprecation policy in
Relay's [webhook guide](https://docs.relayapp.im/guides/webhooks).

## Deprecated, still supported

| Deprecated | Replacement | Supported until |
| --- | --- | --- |
| `RelaySendResult.messageId` | `RelaySendResult.messages` | The next major version |
| `RelayReplyTarget.part_index` | `RelayReplyTarget.part_id` | As long as Relay's `/v1` routes accept it |
| `client.sendMessage` (`/v1`) | `client.sendMessageV2` | At least 90 days after `/v2` reaches general availability |

`messageId` was never the whole answer on `/v1`: one send can commit several
messages, so a single id names only the first of them. On `/v2` it is the id you
minted, which you already had.

`part_index` is a position, and a position is not an identity. Relay translates
a `/v1` `part_index` to that part's `part_id` at the boundary and never stores
the index, which is what lets an edit reorder parts without breaking anything
that pointed at them.

## The v1 to v2 window

Relay's `/v1` message and reaction routes are supported for **at least 90 days
after `/v2` reaches general availability**. Deprecation is announced before the
window opens. The window is a promise about notice, not about the change never
arriving.

Both wires read and write the same rows, so a message sent on one is a message
the other serves, and you can migrate one call site at a time.

| Behaviour | `/v1` | `/v2` |
| --- | --- | --- |
| One send | Split into content runs, so mixed parts commit as several messages | One message, holding every part |
| Retry key | `Idempotency-Key` header | `message_id` in the body, minted by you |
| Reply target | `part_id`, or a legacy `part_index` | `part_id` only |
| Edit | One text part replaces the message body | Part operations against `expected_version` |

`/v1` keeps splitting sends into content runs. Shipped clients render one bubble
per message and would show a mixed send as one unreadable balloon if the split
changed under them, so it is a property of the `/v1` wire rather than a bug to
be fixed there.

## Migrating a send

```ts
// Before: one send, several messages, a header as the retry key.
const { messages } = await client.sendMessage({
  conversationId,
  parts: [{ type: "text", text: "Here it is:" }, { type: "media", attachment_id }],
  idempotencyKey: `reply-${event.event_id}`,
});

// After: one send, one message, an id you minted as the retry key.
const messageId = relayId("msg");
const { message } = await client.sendMessageV2({
  conversationId,
  messageId,
  parts: [{ type: "text", text: "Here it is:" }, { type: "media", attachment_id }],
});
```

Mint `messageId` once per logical send and reuse it across retries. Minting a
fresh one on retry is how you send the same message twice.

## Types follow the schema, not the other way round

`src/types.ts` is derived field for field from
`schemas/message-v2.schema.json`, which Relay-Server owns and generates from
real server responses. `npm run check` fails when the two disagree.

Do not add a field to the types to model something the schema does not publish.
Land it in Relay-Server first, copy the schema over, then follow it here.
