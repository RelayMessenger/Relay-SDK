# Relay skill distributions

This directory holds the portable and Claude plugin manifests plus the
deterministic Codex and Cursor distribution machinery. The one editable Relay
skill is [`../../skills/relay`](../../skills/relay/SKILL.md).

The Relay skill teaches the locked Relay v1 contract: Agent Tokens, signed
Webhooks, acknowledged WebSocket delivery, Chats, Messages, ordered parts,
Attachments, receipts, groups, Add requests, retries, and errors.

Relay-SDK is the canonical source. The dedicated Codex and Cursor repositories
are generated from it so their host-specific layouts never become independent
editable copies.

## Source layout

| Path | Purpose |
| --- | --- |
| [`../../skills/relay`](../../skills/relay/SKILL.md) | Canonical Relay skill and references |
| [`plugin.json`](plugin.json) | Agent Plugins 1.0.0 manifest |
| [`mcp.json`](mcp.json) | Portable Relay docs MCP configuration |
| [`.claude-plugin`](.claude-plugin/plugin.json) | Claude Code manifest and marketplace |
| [`src/plugins/codex`](src/plugins/codex) | Codex distribution templates |
| [`src/plugins/cursor`](src/plugins/cursor) | Cursor distribution templates |
| [`src/distribution`](src/distribution) | Shared tests and SDK example |
| [`scripts/build-distribution.py`](scripts/build-distribution.py) | Deterministic distribution generator |

The docs MCP is useful for search and retrieval. Every returned route, field,
event, and SDK call still has to agree with the locked OpenAPI and SDK sources
recorded in
[`relay-v1-lock.json`](../../skills/relay/references/relay-v1-lock.json).

## Build distributions

The build scripts rewrite an existing target repository while preserving its
`.git` directory:

```bash
src/plugins/codex/build.sh ../Relay-Codex
src/plugins/cursor/build.sh ../Relay-Cursor
```

Each generated repository includes `.relay-source.json` with the exact source
commit, source-file hashes, generated-file hashes, generator path, and locked
Relay contract provenance. Generated repositories must not be edited by hand.

## Validate

```bash
python3 scripts/validate.py
scripts/validate-host-manifests.sh
```

Linux validation and package/example execution belong in the configured
Daytona sandbox.

## License

MIT
