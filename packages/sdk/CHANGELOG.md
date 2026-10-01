# Changelog

All notable changes to `@relaymessenger/sdk` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## 0.4.0 (unreleased)

A minor release, because this is 0.x and the release breaks existing code
(semver 2.0.0 item 4). The version is `0.4.0-staging.N` on staging; the
release on main publishes `0.4.0`.

### Removed: breaking

Relay removed the matching routes. There is no compatibility stub.

- A2A and tasks (#415, Relay-Server PR 462): `client.tasks` (`send`, `get`,
  `cancel`, `list`, `updateStatus`, `reply`, `addArtifact`), `me.update`
  (`accepts_tasks`), the `a2aBaseURL` option and the A2A client transport, the
  `A2a*` and `Task*` types, the four `task.*` webhook events, and the `a2a`
  field on `message.received`. `@a2a-js/sdk` is no longer a dependency.
- Communities (#411, Relay-Server PR 457): `client.communities`,
  `client.communities.members`, their types and their six operations.

### Changed: breaking types

Required fields that the published 0.3.6 did not have. Code that builds these
types by hand (fixtures, mocks) must add them.

- `PaymentRequest.application_fee_amount` (#416): Relay's 5% fee
  in minor units, 0 when 5% rounds to nothing.
- `ContactEventContact.timezone` (`string | null`, #414) and
  `ContactEventContact.age_range` (`AgeRange | null`, #421).

The selection unions (#417) can also stop code from compiling; see "Changed:
compile-time only" below.

### Added

- List picker on `selection` (Relay-Server PR 466): optional titled `sections`,
  a per-row `id`, `subtitle` and HTTPS `image_url`, `multiple` (default `true`),
  a card `subtitle`, and `reply_message` for the answered bubble. `selectionReply`
  returns `selected_ids` and the copied `reply_message`.

### Changed: compile-time only

Every payload that compiled and was valid before is still accepted by Relay at
run time. These type changes can still stop existing TypeScript from compiling:

- `SelectionOption` is now a union: a row has `id` (with an optional matching
  `value`), or the legacy `value` alone. Code that reads `option.value` from a
  `SelectionOption` must handle `undefined`, or read the response type
  `SelectionOptionResponse`, where `id` and `value` are both present.
- `SelectionPart` is now a union with exactly one of `options` or `sections`.
  `part.options` is optional on the type; narrow with `"options" in part`
  before reading it. A `SelectionPart` built with neither, or with both, no
  longer compiles.
- `SelectionResponsePartResponse.selected_ids` is required: Relay returns it on
  every `selection_response` it reads back. Hand-written fixtures of that type
  must add `selected_ids`, equal to `selected_values`.
- `SelectionPartResponse` gains `selected_ids` (`string[] | null`), and its
  `options` items are `SelectionOptionResponse`.
