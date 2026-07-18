# relayapp

Developer tools for [Relay](https://relayapp.im) — messaging for agents.
Message Claude Code, Codex, or Hermes Agent from your phone, or use Relay as
an OpenClaw channel:
texts become engine turns, replies come back as messages, and tool approvals
arrive as Allow/Deny cards you answer with a tap.

Docs: https://docs.relayapp.im

## What's here

| Path | What it is |
| --- | --- |
| [`packages/relayapp`](packages/relayapp) | The `relayapp` CLI (npm): `pair` a machine with the Relay app via QR/code, drive Claude Code, Codex, or Hermes Agent over ACP, and install the bundled Codex, Claude Code, or OpenClaw integration. |
| [`integrations/claude-code`](integrations/claude-code) | Claude Code **channel plugin** (official Channels contract): push Relay messages into a running session, reply tool, phone permission relay. The npm CLI bundles and installs this plugin from a local marketplace; no GitHub checkout is required. |
| [`integrations/openclaw`](integrations/openclaw) | OpenClaw channel plugin: an OpenClaw agent as a Relay contact (long-poll receive, durable chunked replies). The npm CLI bundles its installable archive. |

## Quickstart

```sh
npm install -g relayapp
relayapp pair            # QR + code → claim in the Relay app
relayapp start --engine claude   # or codex | hermes

# Or install a native channel after pairing:
relayapp install-claude
relayapp install-openclaw
```

Full guide: https://docs.relayapp.im/guides/coding-agents

All four integration surfaces are release-gated together on Linux and Windows;
the installed `relayapp` tarball and its Claude/Codex adapter runtime also run
on macOS CI.

## relayapp npm release contract

Only `packages/relayapp` is published by the automated npm release. Its tarball
contains a strictly validated Claude Code marketplace and an installable
OpenClaw plugin archive generated from the matching integration sources. The
integration workspaces are not published separately by this workflow.

1. Update the CLI version and root lock metadata together:

   ```sh
   npm version 0.2.0 --workspace relayapp --no-git-tag-version
   npm run validate
   npm run pack:check
   ```

2. Merge that exact version change, then create and push an existing-commit
   tag named `relayapp-v0.2.0`. The version in
   `packages/relayapp/package.json`, the workspace entry in `package-lock.json`,
   and the tag must match exactly.
3. The tag starts `.github/workflows/release-relayapp.yml`; a manual dispatch
   accepts an existing tag for a controlled retry. The workflow refuses a
   missing `NPM_TOKEN` before a new publish. It never creates a repository,
   changes repository visibility, or creates/pushes a tag.
4. CI reruns the full validation and package smokes, publishes only `relayapp`,
   strictly validates the source Claude plugin and marketplace, and proves the
   packed OpenClaw plugin through a real isolated gateway turn. It uses npm
   provenance when GitHub reports a public source repository. Private-source
   releases publish without provenance rather than changing visibility.
5. Before any retry, the workflow reconciles npm state. An already-published
   version is accepted only when its registry integrity matches the tagged
   source; publish is skipped and registry verification resumes. Finally,
   `scripts/verify-relayapp-registry.mjs` installs the exact registry version
   into a clean directory, loads the CLI, resolves both pinned ACP adapter
   runtimes, and verifies that both bundled native-integration artifacts are
   present.

The repository is available under the MIT License; each integration documents
its own trust, delivery, and crash-recovery boundary.
