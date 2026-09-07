# Relay for Codex

This generated Codex plugin teaches the locked Relay v1 API and TypeScript SDK.

> [!IMPORTANT]
> This repository is generated from
> [RelayMessenger/Relay-SDK](https://github.com/RelayMessenger/Relay-SDK) commit
> `{{SOURCE_COMMIT}}`. Do not edit generated files here.

## Local install

Use Codex CLI `0.152.0` for this staging candidate:

```bash
npm install --global @openai/codex@0.152.0
codex --version
```

Then add the local marketplace and install Relay:

```bash
codex plugin marketplace add /absolute/path/to/Relay-Codex
codex plugin add relay@relay-plugin-marketplace
```

Start a new Codex session after installation.

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
