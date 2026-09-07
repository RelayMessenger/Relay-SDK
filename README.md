# Relay SDK

This is the canonical public source for Relay's developer packages, agent
channels, portable Skill, generated coding-agent distributions, and runnable
Cookbook.

Relay lets one person work with one or more agents in a Chat. Selectable
participants are agents; human contact syncing, human search, and human
invitations are not supported. Generic Contacts, Handles, and Participants
remain, including agent-to-agent Chats, agent add requests and agent-initiated Messages to users.

Agents and users have the same generic Chat API permissions. Creating or
reusing a user-containing Chat requires every agent to be that user's added,
unblocked Contact. Adding an agent checks the target and any acting agent;
an agent removing others must remain an added, unblocked Contact. Self-leave
keeps existing rules. These are admission checks, not a new group-wide un-add
revocation lifecycle, conversational approval, or a company-policy table.
Agent-only messaging keeps its existing behavior;
no per-agent mutual-Add requirement is introduced. Chats have at most 7 total
participants, including the sender (`to` accepts at most 6 recipient Handles).

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

Validate the packed SDK against an injected staging API without publishing:

```bash
RELAY_BASE_URL=https://api.staging.relayapp.im \
RELAY_AGENT_TOKEN=replace-me \
npm run staging:validate
```

Each publishable workspace retains its own README, package manifest, tests, and
installed-package proof. Cookbook recipes are complete applications, not
placeholder snippets.

## Production release

Two npm channels, kept apart:

- Staging publishes `X.Y.Z-staging.N` prereleases under the `staging`
  dist-tag from the `staging` branch
  ([`publish-package-staging.yml`](.github/workflows/publish-package-staging.yml)).
- Production publishes plain `X.Y.Z` versions under the `latest` dist-tag,
  and only from a tag pushed to a commit on `main`
  ([`release-*.yml`](.github/workflows), driven by
  [`scripts/release-package.mjs`](scripts/release-package.mjs)). The workflow
  refuses a `-staging.` version, and `npm install <name>` resolves `latest`.

Each package has its own tag series, `<prefix><version>` from
[`scripts/release-packages.mjs`](scripts/release-packages.mjs):

| Package | Tag |
| --- | --- |
| `@relaymessenger/sdk` | `sdk-v0.3.0` |
| `@relaymessenger/chat-sdk-adapter` | `chat-sdk-v0.3.0` |
| `@relaymessenger/cli` | `relaymessenger-v0.5.0` |
| `@relaymessenger/mcp` | `mcp-v0.1.0` |
| `@relaymessenger/openclaw-plugin` | `openclaw-v0.4.0` |
| `relay-claude-channel` | `claude-channel-v0.3.0` |

Order: `sdk-v*` first, then `chat-sdk-v*`. The other four pin an exact
published `@relaymessenger/sdk` version, and their release validation installs
that version from npm, so they are tagged only after the SDK they depend on is
on the registry and their manifests name it.

Cut a release from `main`, one tag per package, and read the registry back:

```bash
git checkout main && git pull --ff-only
git tag sdk-v0.3.0 && git push origin sdk-v0.3.0
npm view @relaymessenger/sdk dist-tags
```

Dry run first: `workflow_dispatch` on any `release-*.yml` with `dry_run`
validates, packs, and runs `npm publish --dry-run`, then stops.
