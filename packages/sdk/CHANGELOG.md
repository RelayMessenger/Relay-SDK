# Changelog

All notable changes to `@relaymessenger/sdk` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

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
