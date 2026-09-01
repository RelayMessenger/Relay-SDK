# Relay SDK

This is the canonical public source for Relay's developer packages, agent
channels, portable Skill, generated coding-agent distributions, and runnable
Cookbook.

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

cookbook/
  webhook-receiver/
  websocket-agent/
  cloudflare-think-agent/
  messages-and-attachments/
```

All public code is pinned to the same Relay v1 OpenAPI under
[`contracts/relay-v1-openapi.yaml`](contracts/relay-v1-openapi.yaml).
[`sources.lock.json`](sources.lock.json) records the exact audited standalone
commits imported during consolidation.

Relay-Hermes remains separate because it is a Python plugin installed directly
by Hermes. Relay Docs and private product repositories also remain separate.
Relay-Codex and Relay-Cursor are generated installation mirrors; their editable
source lives here.

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
