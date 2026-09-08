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
  cli/                    relaymessenger
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

Nothing is published by hand. Two npm channels, kept apart:

- Staging publishes `X.Y.Z-staging.N` prereleases under the `staging`
  dist-tag on every push to the `staging` branch
  ([`publish-package-staging.yml`](.github/workflows/publish-package-staging.yml)).
  Nobody writes a version: [`scripts/staging-bump.mjs`](scripts/staging-bump.mjs)
  packs each package, compares its files with the tarball npm holds for the
  version in the tree, and when they differ moves the version, `-staging.N`
  to `-staging.N+1` while the plain `X.Y.Z` is unpublished, or to
  `X.Y.(Z+1)-staging.0` once `X.Y.Z` is on npm (a prerelease ranks below its
  base, so the base must move for main to publish again). Dependents are
  pinned to the versions decided in the same run. The workflow commits that
  bump to `staging` as `github-actions[bot]` and publishes each changed
  package from that commit, in the order below.
- Production publishes plain `X.Y.Z` versions under the `latest` dist-tag.
  The one deliberate act is merging `staging` into `main`; the push to `main`
  runs [`release.yml`](.github/workflows/release.yml), which:
  1. derives each package's version by stripping the `-staging.N` prerelease
     from the manifest in the tree (`0.3.0-staging.9` becomes `0.3.0`);
  2. pins every `@relaymessenger/*` dependency between these packages to those
     derived versions at publish time (the tree itself keeps staging's
     manifests, so no version-bump PR exists);
  3. skips any package whose derived version is already on npm;
  4. publishes the rest in dependency order with `--tag latest
     --no-provenance` on Blacksmith with the `npm-release` credential;
  5. creates the git tag `<prefix><version>` after each successful publish, as
     the record, never as the trigger;
  6. installs each published version clean from the registry and exercises it.

Order and record tags, from [`scripts/release-packages.mjs`](scripts/release-packages.mjs):

| Order | Package | Record tag |
| --- | --- | --- |
| 1 | `@relaymessenger/sdk` | `sdk-v<version>` |
| 2 | `@relaymessenger/chat-sdk-adapter` | `chat-sdk-v<version>` |
| 3 | `relaymessenger` | `relaymessenger-v<version>` |
| 4 | `@relaymessenger/mcp` | `mcp-v<version>` |
| 5 | `@relaymessenger/openclaw-plugin` | `openclaw-v<version>` |
| 6 | `relay-claude-channel` | `claude-channel-v<version>` |

Dry run first: `workflow_dispatch` on `release.yml` derives every version,
prints the skip-or-publish decision, packs, and runs `npm publish --dry-run`,
then stops; `assume_published` lets a dry run rehearse a skip. Read the
registry back with `npm view <name> dist-tags`. The logic lives in
[`scripts/release-derive.mjs`](scripts/release-derive.mjs) (derivation, order,
plan, manifest rewrite; tested by `scripts/release-derive.test.mjs`) and
[`scripts/release-run.mjs`](scripts/release-run.mjs) (npm, registry, tag).
