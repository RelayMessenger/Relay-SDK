# Changelog

All notable changes to `@relaymessenger/sdk`.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this package follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
See [BREAKING-CHANGES.md](./BREAKING-CHANGES.md) for what counts as a break.

## [Unreleased]

This package has not shipped a release yet, so the entry below describes the
whole surface rather than a diff against a published version.

### Added

- `createRelayClient({ token, baseUrl?, fetchImpl?, requestTimeoutMs? })` over
  the Relay agent API, authenticating with an `rly_live_` API key.
- `sendMessage({ conversationId, messageId?, parts, replyTo?, fallbackText? })`.
  One send is one message: mixed text and media stay together, and every part
  comes back with a permanent `part_id`. Mints a `msg_` ULID when `messageId` is
  absent; that id is both the message's identity and the send's only retry key,
  so no `Idempotency-Key` is involved. `sendMessageV1` is the same call against
  the `/v1` route, which answers with a one-element array.
- `react({ messageId, operation, emoji, targetPartId? })`. Omitting
  `targetPartId` reacts to the whole message; supplying it reacts to one exact
  part, of any kind. One reaction per actor per slot, and repeating a request
  changes nothing.
- `pollEvents({ after, timeoutSeconds?, limit? })`, a plain pull of the agent's
  durable event log returning `{ events, nextCursor, latest, hasMore }`. It
  coexists with webhooks, holds no consumer slot, and has nothing to reconcile.
- `getPoll`, `votePoll` and `closePoll` for the poll routes.
- `uploadAttachment`, `getHistory`, `markRead`, `markDelivered`, and
  `setTyping`, which is one fire-and-forget `{ started }` flag with no lease.
- A dependency-free ULID generator: `ulid`, `relayId`, `isRelayId`,
  `createUlidFactory`, `RELAY_ID_PATTERN`. Lowercase Crockford base32, and
  monotonic within a process so ids minted in the same millisecond still sort in
  creation order.
- `runPollLoop`, `MemoryDedupe`, `createFileCursorStore` and
  `verifyWebhookSignature` for hosts that receive rather than poll.
- `isKnownPartKind` for narrowing, plus the wire types the message model
  publishes: `RelayMessage`, `RelayPart`, `RelayActor`, `RelayReaction`,
  `RelayReplyRef`, `RelayPoll`, `RelayReceipt`, `RelayEventEnvelope`.
- `scripts/check-types-against-schema.mjs`, wired into `npm run check`. It reads
  `schemas/message-v2.schema.json` and fails the build when a property the
  contract publishes has no counterpart in `src/types.ts`. Set
  `RELAY_SERVER_DIR` to also assert the vendored schema is byte-identical to the
  copy Relay-Server owns.

### Changed

- `types.ts` is derived field for field from
  `schemas/message-v2.schema.json`, a byte copy of the file Relay-Server
  generates from real server responses.
- `RelayPart["type"]` is `string` rather than a closed union. Relay ships new
  part kinds without a version bump, so a client that rejected one would break
  on a message it could have rendered. Narrow with `isKnownPartKind` and fall
  back to the message's `fallback_text`.
- Every wire type carries an index signature, because Relay adds optional
  members additively.

### Removed

Relay's server cleanup removed the features below outright. See
[BREAKING-CHANGES.md](./BREAKING-CHANGES.md) for the full table.

- Message editing, unsending and deletion, and everything that modelled them:
  `editMessage`, `unsendMessage`, `buildEditRequest`, `MAX_OPERATIONS_PER_EDIT`,
  `isVisibleMessage`, and the `version`, `revisions`, `edit_capabilities` and
  tombstone shapes. Message content is immutable.
- The `/v1` send split. `RelaySendResult` is `{ messageId, message }`.
- Invocations and responding: `setResponding`, `invocationId`,
  `invokedAgentIds`, and `MessageHandlerContext.responding`.
- The event-consumer model: `reconcileEvents`, `classifyCursorGap`,
  `isRelayWebhookConflict`, and the `cursor_expired` / `terminated_by_other_consumer`
  failure modes.
- All idempotency machinery beyond the `msg_` id: the `idempotency` module,
  `deriveIdempotencyKey`, `replyIdempotencyKey`, and every `Idempotency-Key`
  header.
- Reply quotes (`RelayReplyQuote`, `RelayQuoteState`) and the `part_index` reply
  and reaction forms.
- The `monospace` and `spoiler` text styles and the `system` sender kind.
