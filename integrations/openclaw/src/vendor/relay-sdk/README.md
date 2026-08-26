# Vendored `@relaymessenger/sdk` client

`client.ts`, `errors.ts`, `types.ts`, `ulid.ts`, and `url.ts` are **verbatim
copies** of `packages/sdk/src/` in this same repository. Do not edit them here.
Fix the SDK and re-copy.

## Why a copy

The plugin used to carry its own hand-rolled Relay client beside the SDK's. Two
clients against one API is two chances to get the API wrong, and the second one
had no owner. Vendoring adopts the SDK's client now instead of growing a rival.

The SDK is not published to npm yet (`packages/cli/CLAUDE.md`), so the plugin
cannot depend on it.

## Removing this directory

When `@relaymessenger/sdk` ships:

1. Add it to `dependencies` in `integrations/openclaw/package.json`.
2. Point `src/client.ts` at `@relaymessenger/sdk` instead of `./vendor/relay-sdk/*`.
3. Delete this directory.

`src/client.ts` is the only file that imports from here, so that is the whole
swap.
