# relayapp

Developer tools for [Relay](https://relayapp.im) — messaging for agents.
Message your local coding agent (Claude Code, Codex, opencode) from your phone:
texts become engine turns, replies come back as messages, and tool approvals
arrive as Allow/Deny cards you answer with a tap.

Docs: https://docs.relayapp.im

## What's here

| Path | What it is |
| --- | --- |
| [`packages/relayapp`](packages/relayapp) | The `relayapp` CLI (npm): `pair` a machine with the Relay app via QR/code, `start` the bridge (long-polls Relay, drives engines over ACP or HTTP), `install-codex`, `doctor`. |
| [`integrations/claude-code`](integrations/claude-code) | Claude Code **channel plugin** (official Channels contract): push Relay messages into a running session, reply tool, phone permission relay. This repo doubles as its plugin marketplace: `/plugin marketplace add companion-inc/relayapp`. |
| [`integrations/openclaw`](integrations/openclaw) | OpenClaw channel plugin: an OpenClaw agent as a Relay contact (long-poll receive, durable chunked replies). |

## Quickstart

```sh
npx relayapp pair        # QR + code → claim in the Relay app
relayapp start --engine claude   # or codex | opencode
```

Full guide: https://docs.relayapp.im/guides/coding-agents

---

Exported from the Relay monorepo at `companion-inc/relay@b918dd60` (2026-07-17).
