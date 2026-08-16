# Relay SDK

One repo for building on [Relay](https://relayapp.im), the messenger for AI
agents. It ships the `relaymessenger` npm tool (published as
`@relaymessenger/cli`, name unchanged), the runtime integrations it bundles,
the `@relaymessenger/core` contract and transport library, and forkable agent
examples. Message Claude Code, Codex, or Hermes Agent from your phone, or run
Relay as an OpenClaw channel: texts become engine turns, replies come back as
messages, and tool approvals arrive as Allow/Deny cards you answer with a tap.

Docs: https://docs.relayapp.im

## What's here

| Path | What it is |
| --- | --- |
| [`packages/relaymessenger`](packages/relaymessenger) | The `relaymessenger` CLI (npm, `@relaymessenger/cli`): `pair` a machine with the Relay app via QR/code, drive Claude Code, Codex, or Hermes Agent over ACP, and install the bundled Codex, Claude Code, or OpenClaw integration. |
| [`packages/core`](packages/core) | `@relaymessenger/core`: Relay contract types and transport (HTTPS client, Standard Webhooks verify, durable long-poll, idempotent sends). Not yet published to npm; its types will become generated from the Relay-Server schemas so the wire contract has one source of truth. |
| [`integrations/claude-code`](integrations/claude-code) | Claude Code **channel plugin** (official Channels contract): push Relay messages into a running session, reply tool, phone permission relay. The npm CLI bundles and installs this plugin from a local marketplace; no GitHub checkout is required. |
| [`integrations/openclaw`](integrations/openclaw) | OpenClaw channel plugin: an OpenClaw agent as a Relay contact (long-poll receive, durable chunked replies). The npm CLI bundles its installable archive. |
| [`integrations/vercel-ai`](integrations/vercel-ai) | Vercel AI SDK webhook plugin (`@relaymessenger/vercel-ai`): verify signed Relay webhooks, then stream `streamText(...)` back as one canonical message. |
| [`examples`](examples) | Forkable agents built on `@relaymessenger/core` ([`raw-webhook-agent`](examples/raw-webhook-agent), [`showcase-agent`](examples/showcase-agent)), plugin landing zones ([`examples/plugins`](examples/plugins)), and smoke harnesses ([`examples/harnesses`](examples/harnesses)). |

## Quickstart

```sh
npm install -g @relaymessenger/cli
relaymessenger pair            # QR + code → claim in the Relay app
relaymessenger start --engine claude   # or codex | hermes

# Or install a native channel after pairing:
relaymessenger install-claude
relaymessenger install-openclaw
```

Full guide: https://docs.relayapp.im/guides/coding-agents

All four integration surfaces are release-gated together on Linux and Windows;
the installed `relaymessenger` tarball and its Claude/Codex adapter runtime also run
on macOS CI. `@relaymessenger/core` and the examples typecheck, build, and test
inside the same `npm run validate` gate.

## npm release contracts

Only `packages/relaymessenger` is published by the automated npm release. Its tarball
contains a strictly validated Claude Code marketplace and an installable
OpenClaw plugin archive generated from the matching integration sources. The
Claude Code and OpenClaw workspaces are bundled artifacts, not independent npm
packages. `integrations/vercel-ai` is published separately as
`@relaymessenger/vercel-ai`.

1. Update the CLI version and root lock metadata together:

   ```sh
   npm version X.Y.Z --workspace @relaymessenger/cli --no-git-tag-version
   npm run validate
   npm run pack:check
   ```

2. Merge that exact version change, then create and push an existing-commit
   tag named `relaymessenger-vX.Y.Z`. The version in
   `packages/relaymessenger/package.json`, the workspace entry in `package-lock.json`,
   and the tag must match exactly.
3. The tag starts `.github/workflows/release-relaymessenger.yml`. npm trusts that
   exact workflow through GitHub OIDC; no long-lived write token is allowed. If a
   tag run fails before terminal verification, rerun that original GitHub Actions
   run so npm provenance stays bound to the release tag and tag commit. The
   workflow deliberately has no manual-dispatch path: checking out an old tag from
   a default-branch dispatch would make GitHub's automatic provenance name the
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
   `scripts/verify-relaymessenger-registry.mjs` installs the exact registry version
   into a clean directory, loads the CLI, resolves both pinned ACP adapter
   runtimes, and verifies that both bundled native-integration artifacts are
   present.

`@relaymessenger/vercel-ai` follows the same contract through
`.github/workflows/release-vercel-ai.yml` and tags named `vercel-ai-vX.Y.Z`.

The repository is available under the MIT License; each integration documents
its own trust, delivery, and crash-recovery boundary.
