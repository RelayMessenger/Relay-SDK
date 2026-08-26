# Relay SDK

One repo for building on [Relay](https://relayapp.im), the messenger for AI
agents. An agent on Relay is an AI that does things for you, and people message
it the way they message a contact.

This repo ships the `relaymessenger` npm tool (published as
`@relaymessenger/cli`, name unchanged), the runtime integrations it bundles,
the `@relaymessenger/sdk` contract and transport library, adapters for other
agent frameworks, and forkable agent examples. Message Claude Code, Codex, or
Hermes Agent from your phone, or run Relay as an OpenClaw channel: texts become
engine turns, replies come back as messages, and tool approvals arrive as
Allow/Deny cards you answer with a tap.

Docs: https://docs.relayapp.im

The Relay app itself is invite-only and on TestFlight. Join the waitlist at
[relayapp.im](https://relayapp.im).

## What's here

| Path | What it is |
| --- | --- |
| [`packages/cli`](packages/cli) | The `relaymessenger` CLI (npm, `@relaymessenger/cli`): `pair` a machine with the Relay app via a device code you approve in the app, drive Claude Code, Codex, or Hermes Agent over ACP, and install the bundled Codex, Claude Code, or OpenClaw integration. |
| [`packages/sdk`](packages/sdk) | `@relaymessenger/sdk`: Relay contract types and transport (HTTPS client, Standard Webhooks verify, durable event cursors, sends keyed by a client-minted `msg_` id). Its types follow `schemas/message-v2.schema.json`, which Relay-Server owns, so the wire contract has one source of truth. |
| [`integrations/claude-code`](integrations/claude-code) | Claude Code **channel plugin** (`relay-claude-channel`, official Channels contract): push Relay messages into a running session, reply tool, phone permission relay. The npm CLI bundles and installs this plugin from a local marketplace; no GitHub checkout is required. |
| [`integrations/openclaw`](integrations/openclaw) | OpenClaw channel plugin (`@relaymessenger/openclaw-plugin`): an OpenClaw agent as a Relay agent (event-poll receive, durable replies). The npm CLI bundles its installable archive. |
| [`integrations/vercel-ai`](integrations/vercel-ai) | Vercel AI SDK webhook plugin (`@relaymessenger/vercel-ai`): verify signed Relay webhooks, then stream `streamText(...)` back as one canonical message. |
| [`integrations/chat-sdk`](integrations/chat-sdk) | Vercel Chat SDK adapter (`@relaymessenger/chat-sdk-adapter`): a Relay conversation becomes a Chat SDK thread, so anything built on the Chat SDK reaches Relay users. |
| [`examples`](examples) | Forkable agents built on `@relaymessenger/sdk` ([`raw-webhook-agent`](examples/raw-webhook-agent), [`showcase-agent`](examples/showcase-agent)), an [eve channel template](examples/eve), plugin landing zones ([`examples/plugins`](examples/plugins)), and smoke harnesses ([`examples/harnesses`](examples/harnesses)). |

## Quickstart

```sh
npm install -g @relaymessenger/cli
relaymessenger pair            # shows a code → approve it in the Relay app
relaymessenger start --engine claude   # or codex | hermes

# Or install a native channel once the device is linked:
relaymessenger install-claude
relaymessenger install-openclaw
```

Full guide: https://docs.relayapp.im/integrations

Every integration surface is release-gated together on Linux and Windows; the
installed `relaymessenger` tarball and its Claude/Codex adapter runtime also run
on macOS CI. `@relaymessenger/sdk` and the examples typecheck, build, and test
inside the same `npm run validate` gate.

## Claude Code plugin marketplace

This repository is also a Claude Code plugin marketplace:
`.claude-plugin/marketplace.json` at the repo root lists the Relay channel
plugin from `integrations/claude-code`. In Claude Code, run
`/plugin marketplace add relaymessenger/Relay-SDK` to add it, then install the
`relay` plugin from that marketplace.

## npm release contracts

Six packages publish from this repository, each through its own tag-triggered
workflow. Every one uses npm OIDC trusted publishing; no long-lived write token
is allowed anywhere.

| Package | Source | Tag | Workflow |
| --- | --- | --- | --- |
| `@relaymessenger/cli` | `packages/cli` | `relaymessenger-vX.Y.Z` | `release-cli.yml` |
| `@relaymessenger/sdk` | `packages/sdk` | `sdk-vX.Y.Z` | `release-sdk.yml` |
| `@relaymessenger/vercel-ai` | `integrations/vercel-ai` | `vercel-ai-vX.Y.Z` | `release-vercel-ai.yml` |
| `@relaymessenger/chat-sdk-adapter` | `integrations/chat-sdk` | `chat-sdk-vX.Y.Z` | `release-chat-sdk.yml` |
| `@relaymessenger/openclaw-plugin` | `integrations/openclaw` | `openclaw-vX.Y.Z` | `release-openclaw.yml` |
| `relay-claude-channel` | `integrations/claude-code` | `claude-channel-vX.Y.Z` | `release-claude-channel.yml` |

The workflow filename is part of each package's release identity, not a label.
npm's trusted-publisher record names that exact file, so renaming one is a
coordinated change with npmjs.com. `scripts/release-workflow.test.mjs` holds the
filename, the release script, and the retained artifact name on one slug, so the
trust record's filename leads to every part of the release it authorizes. Tag
prefixes are the release series each package has always used and deliberately do
not track the filename: `@relaymessenger/cli` keeps `relaymessenger-v*`, which is
also the name of the binary it installs.

The `@relaymessenger/cli` tarball still carries a strictly validated Claude Code
marketplace and an installable OpenClaw plugin archive generated from those
integration sources, so `relaymessenger install-claude` and
`relaymessenger install-openclaw` need no registry install of their own. Those
two packages now also stand on their own for anyone consuming them directly.

The steps below describe the `@relaymessenger/cli` release. The other five
follow the same contract through their own workflow and tag.

1. Update the CLI version and root lock metadata together:

   ```sh
   npm version X.Y.Z --workspace @relaymessenger/cli --no-git-tag-version
   npm run validate
   npm run pack:check
   ```

2. Merge that exact version change, then create and push an existing-commit
   tag named `relaymessenger-vX.Y.Z`. The version in
   `packages/cli/package.json`, the workspace entry in `package-lock.json`,
   and the tag must match exactly.
3. The tag starts `.github/workflows/release-cli.yml`. npm trusts that exact
   workflow through GitHub OIDC; no long-lived write token is allowed. A tag push
   runs the workflow file as it exists in the tagged commit, so a tag whose commit
   predates a workflow rename still presents the old filename to npm and fails the
   trust match; after renaming a release workflow, release from a new tag on a
   commit that contains the rename rather than replaying an older one. If a tag
   run fails before terminal verification, rerun that original GitHub Actions run
   so npm provenance stays bound to the release tag and tag commit. The workflow
   deliberately has no manual-dispatch path: checking out an old tag from a
   default-branch dispatch would make GitHub's automatic provenance name the
   dispatch ref instead of the artifact's source tag. The workflow never creates a
   repository, changes repository visibility, or creates/pushes a tag.
4. CI reruns the full validation and package smokes, publishes only
   `@relaymessenger/cli`,
   strictly validates the source Claude plugin and marketplace, and proves the
   packed OpenClaw plugin through a real isolated gateway turn. The release job
   accepts only tags on reviewed `main` history, uses a GitHub-hosted runner,
   retains the exact `.tgz` with a source-SHA/digest manifest, publishes that
   file, and requires npm's registry integrity to match it. The public repository
   lets npm attach automatic provenance to the public package.
5. Before any retry, the workflow reconciles npm state. An already-published
   version is accepted only when its registry integrity matches the tagged
   source; publish is skipped and registry verification resumes. Finally,
   `scripts/verify-cli-registry.mjs` installs the exact registry version
   into a clean directory, loads the CLI, resolves both pinned ACP adapter
   runtimes, and verifies that both bundled native-integration artifacts are
   present.

The repository is available under the MIT License; each integration documents
its own trust, delivery, and crash-recovery boundary.
