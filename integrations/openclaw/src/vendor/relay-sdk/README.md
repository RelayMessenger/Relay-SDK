# Vendored `@relaymessenger/sdk` client

`client.ts`, `errors.ts`, `types.ts`, and `url.ts` are **verbatim copies** of
`packages/sdk/src/` in this same repository. Do not edit them here. Fix the SDK
and re-copy.

## Why a copy

The plugin used to carry its own hand-rolled Relay client. The two drifted, and
the drift shipped a defect: the plugin's client had no `invocationId` on
`sendMessage`, `setTyping`, or `setResponding`, so the first group mention an
agent received wedged its whole event stream (REL-167). The SDK client has
always had those parameters.

The SDK is not published to npm yet (`packages/cli/CLAUDE.md`), so the plugin
cannot depend on it. Vendoring adopts the correct client now instead of growing
a second one.

## Removing this directory

When `@relaymessenger/sdk` ships:

1. Add it to `dependencies` in `integrations/openclaw/package.json`.
2. Point `src/client.ts` at `@relaymessenger/sdk` instead of `./vendor/relay-sdk/*`.
3. Delete this directory.

`src/client.ts` is the only file that imports from here, so that is the whole
swap.
