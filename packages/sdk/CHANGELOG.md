# Changelog

All notable changes to `@relaymessenger/sdk`.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this package follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
See [BREAKING-CHANGES.md](./BREAKING-CHANGES.md) for what counts as a break.

## [Unreleased]

### Fixed

- `sendMessage` read `body.message` from a response the server sends as
  `{ message_id, messages }`. Every send resolved with `message: undefined`
  while TypeScript reported a `RelayMessage`, so the fault surfaced later at the
  consumer rather than at the call. It now reads `messages`, exposes the whole
  array, and raises a retryable `RelayApiError` when a send returns no committed
  message instead of resolving with nothing.

### Added

- `sendMessageV2({ conversationId, messageId?, parts, replyTo?, invokedAgentIds?, fallbackText? })`.
  One send is one message: mixed text and media stay together, and every part
  comes back with a permanent `part_id`. Mints a `msg_` ULID when `messageId` is
  absent; that id is both the message's identity and the retry key, so no
  `Idempotency-Key` is involved.
- `editMessage({ messageId, operationId?, expectedVersion, operations })` and
  `unsendMessage({ messageId, operationId? })` for the `/v2` mutation routes.
  `expectedVersion` is optimistic concurrency; a stale value is refused rather
  than overwriting somebody else's edit.
- `react({ messageId, operation, emoji, targetPartId?, operationId? })`.
  Omitting `targetPartId` reacts to the whole message; supplying it reacts to
  one exact part, of any kind.
- `uploadAttachment`, `getHistory`, `markDelivered`, and `reconcileEvents`.
- `buildEditRequest` and `MAX_OPERATIONS_PER_EDIT`, so an edit body can be built
  and asserted without a server.
- `classifyCursorGap`, which names an expired cursor and a cursor ahead of
  Relay's, both of which are terminal to a poll loop and neither of which a
  retry repairs.
- A dependency-free ULID generator: `ulid`, `relayId`, `isRelayId`,
  `createUlidFactory`, `RELAY_ID_PATTERN`. Lowercase Crockford base32, and
  monotonic within a process so ids minted in the same millisecond still sort in
  creation order.
- `isKnownPartKind` and `isVisibleMessage` for narrowing, plus the wire types
  the message model publishes: `RelayReaction`, `RelayReplyQuote`,
  `RelayRevision`, `RelayEditCapabilities`, `RelayPartOperation`,
  `RelayReceiptSummary`, `RelayTombstone`, `RelayVisibleMessage`.
- `scripts/check-types-against-schema.mjs`, wired into `npm run check`. It reads
  `schemas/message-v2.schema.json` and fails the build when a property the
  contract publishes has no counterpart in `src/types.ts`. Set
  `RELAY_SERVER_DIR` to also assert the vendored schema is byte-identical to the
  copy Relay-Server owns.

### Changed

- `types.ts` is now derived field for field from
  `schemas/message-v2.schema.json`, a byte copy of the file Relay-Server
  generates from real server responses.
- `RelayPart` gains `part_id`, `part_index` and `position`, and its `type` is
  `string` rather than a closed union. Relay ships new part kinds without a
  version bump, so a client that rejected one would break on a message it could
  have rendered. Narrow with `isKnownPartKind` and fall back to the message's
  `fallback_text`.
- Every wire type carries an index signature, because Relay adds optional
  members additively.
- `RelayReplyRef` is the projected reply edge and now carries `part_id`,
  `quote_state` and `quote`. The shape a caller sends is `RelayReplyTarget`,
  where `part_index` is deprecated in favour of `part_id`.
- `RelaySendResult` gains `messages`. `message` stays as the first committed
  message so callers written before the `/v1` split keep working.
- `RelayEventEnvelope` gains `schema_version`.

### Deprecated

- `RelaySendResult.messageId`. A `/v1` send can commit several messages, so a
  single id was never the whole answer; read `messages`. On `/v2` it is simply
  the id you minted.
- `RelayReplyTarget.part_index`. Accepted on `/v1` only, where Relay translates
  it to that part's `part_id` at the boundary and never stores the index.
