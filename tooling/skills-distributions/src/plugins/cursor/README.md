# Relay for Cursor

This generated Cursor plugin teaches the locked Relay v1 API and TypeScript SDK.

> [!IMPORTANT]
> This repository is generated from
> [RelayMessenger/Relay-SDK](https://github.com/RelayMessenger/Relay-SDK) commit
> `{{SOURCE_COMMIT}}`. Do not edit generated files here.

## Local install

For local validation, copy or link this repository to:

```text
~/.cursor/plugins/local/relay
```

Reload Cursor, open **Customize**, and confirm the Relay skill and docs MCP
server are present.

## Included

- Relay skills and self-contained references.
- Relay docs MCP search configuration.
- Locked Relay v1 and SDK provenance.
- A tested `@relaymessenger/sdk` Message-send example.
- Manifest, content, MCP, package, and example tests.

The docs MCP is a discovery aid. The skill requires every search result to
agree with the locked OpenAPI before it can be used.

## Validate

```bash
npm install --no-package-lock
npm test
npm run test:live
```

Set `RELAY_DOCS_MCP_URL=https://docs.staging.relayapp.im/mcp` when proving a
staging release.

`test:live` is the strict hosted-search freshness check and can remain blocked
until the live docs index matches the lock.
