# Relay SDK

This is the canonical public source for Relay's developer packages, agent
channels, portable Skill, generated coding-agent distributions, and runnable
Cookbook.

Relay lets one person work with one or more agents in a Chat. Selectable
participants are agents; human contact syncing, human search, and human
invitations are not supported. Generic Contacts, Handles, and Participants
remain, including agent add requests and agent-initiated Messages to users.

```text
packages/
  sdk/                    @relaymessenger/sdk
  chat-sdk-adapter/       @relaymessenger/chat-sdk-adapter
  cli/                    @relaymessenger/cli
  mcp/                    @relaymessenger/mcp
  openclaw/               @relaymessenger/openclaw-plugin
  claude-code/            relay-claude-channel

skills/
  relay/                  canonical Relay Skill

tooling/
  skills-distributions/   Codex and Cursor mirror generator

plugins/
  relay/                  generated portable and Codex plugin

cookbook/
  webhook-receiver/
  websocket-agent/
  cloudflare-think-agent/
  send-a-message/
  send-an-image/
  send-a-voice-memo/
```

All public code is pinned to the same Relay v1 OpenAPI under
[`contracts/relay-v1-openapi.yaml`](contracts/relay-v1-openapi.yaml).
[`sources.lock.json`](sources.lock.json) records the exact audited standalone
commits imported during consolidation.

Relay-Hermes remains separate because it is a Python plugin installed directly
by Hermes. Relay Docs and private product repositories also remain separate.
Relay-Codex and Relay-Cursor are generated installation mirrors; their editable
source lives here.

## Agent plugin discovery

The repository root is a marketplace for Codex, Cursor, and Claude Code. The
Codex and Cursor entries use [`plugins/relay`](plugins/relay), which is generated
from the canonical [`skills/relay`](skills/relay) and
[`tooling/skills-distributions`](tooling/skills-distributions) sources. The
Claude marketplace points directly at the packaged plugin in
[`packages/claude-code/plugin`](packages/claude-code/plugin).

After cloning Relay-SDK, install the Codex plugin from the repository root:

```bash
codex plugin marketplace add /absolute/path/to/Relay-SDK
codex plugin add relay@relay-plugin-marketplace
```

For local Cursor discovery, link the same generated plugin package and reload
Cursor. The root `.cursor-plugin/marketplace.json` is also available for a
Cursor team marketplace import.

```bash
mkdir -p ~/.cursor/plugins/local
ln -s /absolute/path/to/Relay-SDK/plugins/relay \
  ~/.cursor/plugins/local/relay
```

Install the Relay channel for Claude Code from the root marketplace:

```bash
claude plugin marketplace add /absolute/path/to/Relay-SDK
claude plugin install relay@relay-messenger --scope user
```

Do not edit `plugins/relay` directly. Refresh and validate root discovery with:

```bash
npm run discovery:sync
npm run discovery:validate
```

## Development

```bash
npm ci
npm run validate
```

Validate the packed SDK against an injected staging API without publishing:

```bash
RELAY_BASE_URL=https://api.staging.relayapp.im \
RELAY_AGENT_TOKEN=replace-me \
npm run staging:validate
```

Each publishable workspace retains its own README, package manifest, tests, and
installed-package proof. Cookbook recipes are complete applications, not
placeholder snippets.
