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

## Removed in the server cleanup

These were removed from Relay itself, not merely deprecated here. There is no
replacement and no compatibility window: the behaviour no longer exists.

| Removed | Why |
| --- | --- |
| `client.editMessage`, `client.unsendMessage`, `buildEditRequest`, `MAX_OPERATIONS_PER_EDIT`, `RelayPartOperation`, `RelayEditRequest`, `RelayEditCapabilities`, `RelayRevision`, `RelayTombstone`, `isVisibleMessage` | Message content is immutable. There is no edit, no unsend, no version, and no tombstone, so a message you hold has parts and never changes underneath you |
| `RelaySendResult.messages`, the `/v1` split | One send is one message. `/v1` still answers with an array because shipped clients read one, but it always holds exactly one element |
| `client.setResponding`, `invocationId`, `invoked_agent_ids`, `MessageHandlerContext.responding` | An agent is an ordinary group member. Nothing invokes it, so nothing scopes a reply to an invocation |
| `client.reconcileEvents`, `classifyCursorGap`, `CursorGap`, `RelayReconcileResult`, `isRelayWebhookConflict` | `GET /v1/events` is a plain poll: no exclusive consumer, no acknowledgement handshake, no expiry to reconcile, and it coexists with webhooks |
| `deriveIdempotencyKey`, `replyIdempotencyKey`, every `Idempotency-Key` header | The `msg_` id you mint IS the idempotency mechanism |
| `RelayReplyQuote`, `RelayQuoteState`, `RelayReplyTarget.part_index` | A reply is a pointer `{ message_id, part_id? }`. Nothing is copied, so nothing goes stale |
| `RelayReaction.part_index`, `RelayReaction.target_scope`, reaction `operation_id` | A reaction names its slot by `target_part_id`, or `null` for the whole message, and repeating a request changes nothing |
| `RelayReceiptSummary` | Receipts are per-message stamps in a direct conversation; groups carry none |
| `monospace` and `spoiler` text styles, the `system` sender kind | Gone from the wire. A group notice is a `kind: "notice"` message sent by the person who caused it |

## Renamed

| Before | After |
| --- | --- |
| `client.sendMessageV2` | `client.sendMessage` |
| `client.sendMessage` (`/v1`) | `client.sendMessageV1` |
| `client.pollEvents({ cursor })` | `client.pollEvents({ after })` |
| `RelaySendResult` = `{ messageId, message, messages }` | `{ messageId, message }` |

`RelayEventsPage` gained `latest` and `hasMore` beside `nextCursor`.

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
const { message } = await client.sendMessage({
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
