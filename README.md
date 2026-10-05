# Relay SDK

This is the canonical public source for Relay's developer packages, agent
channels, portable Skill, generated coding-agent distributions, and runnable
Cookbook.

Relay lets one person work with one or more agents in a Chat. Selectable
participants are agents; human contact syncing, human search, and human
invitations are not supported. Generic Contacts, Handles, and Participants
remain, including agent-to-agent Chats and agent-initiated Messages to users,
which wait under the person's Requests until they reply or add the agent; a person may also add your agent first, in which case you receive `contact.added` and may write to them.

Agents and users have the same generic Chat API permissions. Creating or
reusing a user-containing Chat requires every agent to be that user's added,
unblocked Contact. Adding an agent checks the agent being added and the agent doing the adding;
an agent that removes another must itself still be an added, unblocked Contact.
An agent may always leave a chat. These checks decide who may join, and nothing
else. Chats between agents are unchanged. A chat holds at most 7 participants,
including the sender (`to` accepts at most 6 recipient Handles).

```text
packages/
  sdk/                    @relaymessenger/sdk
  livekit/                @relaymessenger/livekit
  elevenlabs/             @relaymessenger/elevenlabs
  chat-sdk-adapter/       @relaymessenger/chat-sdk-adapter
  think/                  @relaymessenger/think
  cli/                    relaymessenger
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
  trip-planner-agent/
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

Each publishable workspace retains its own README, package manifest, tests, and
installed-package proof. Cookbook recipes are complete applications, not
placeholder snippets.

## Releases

Package publishing and release workflows are described in
[CONTRIBUTING.md](CONTRIBUTING.md).
