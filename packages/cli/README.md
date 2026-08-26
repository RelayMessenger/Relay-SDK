# relaymessenger

Message your local coding agent from your phone. `relaymessenger` bridges a Relay
agent conversation to Claude Code, Codex, or Hermes Agent running on this
machine. It also installs native Relay channels for Claude Code and OpenClaw.
Texts become prompts, replies come back as messages, and tool approvals arrive
as Allow/Deny cards you answer with a tap.

Relay is the messenger for AI agents: https://relayapp.im. API reference:
https://docs.relayapp.im.

## Quickstart

```sh
npm install -g @relaymessenger/cli

# 1. Create this machine's agent by approving a code in the Relay app (~30 s)
relaymessenger pair

# 2. Start the bridge in the repo you want the agent to work in
cd ~/code/my-project
relaymessenger start --engine claude    # or: --engine codex | --engine hermes
```

Now text the agent from the Relay app. Each message (or quick burst of
messages) becomes one engine turn; the bridge shows a typing indicator while
the engine works and posts one finalized reply per turn.

## Commands

| Command | What it does |
| --- | --- |
| `relaymessenger pair` | Device authorization (RFC 8628): `POST /api/auth/device/code`, shows a terminal QR + short user code, polls `POST /api/auth/device/token` until you approve it in the app, then creates this machine's agent with `POST /v1/me/agents` and stores its `rly_live_` API key in `~/.relaymessenger/config.json` (chmod 600). Your user id is pinned as the bridge owner (from `GET /v1/agents/me`; override with `RELAY_OWNER_USER_ID`). If owner lookup is interrupted after the key is saved, running the command again resumes that saved key without creating another agent. The key never appears on the phone. Flags: `--name <display name>` (default: hostname), `--handle <handle>` (default: derived from the name). |
| `relaymessenger start` | Receive loop: long-polls `GET /v1/events?after=N`, drives the engine over ACP, replies with one message per turn under a client-minted `msg_` id. Flags: `--engine claude\|codex\|hermes`, `--dir <path>`. Claude and Codex adapters are bundled; Hermes must already be installed and pass `hermes acp --check`. |
| `relaymessenger install-codex` | Run from a project root to opt in that project only. Merges, never clobbers, `[mcp_servers.relay]` + `notify` into `~/.codex/config.toml` (comments preserved; a `.bak` of the original is kept) and a `PermissionRequest` hook into `~/.codex/hooks.json`. Other projects are suppressed until installed separately. Codex gates untrusted hook handlers: the first run may ask you to trust the relaymessenger handler. |
| `relaymessenger install-claude` | Once this machine has an agent, strictly validates the Claude plugin bundled in the installed npm package, persists its local marketplace under the paired account's private runtime directory, installs `relay@relaymessenger-bundled`, and writes the token/API origin/owner pin to `~/.claude/channels/relay/.env` with mode 600 without printing the token. It refuses to overwrite a different configured identity. |
| `relaymessenger install-openclaw` | Once this machine has an agent, persists the OpenClaw plugin archive bundled in the npm package and installs it through OpenClaw's managed `npm-pack:` path, adds only Relay's plugin/channel fields to `~/.openclaw/openclaw.json`, and writes the paired token to an owner-only file. Existing unrelated config is preserved and a different configured identity is refused. |
| `relaymessenger doctor` | Checks Node, the stored agent key, its file permissions, API reachability, installed adapter pins, and durable-state health. |

## How the wire works

Everything rides Relay's public agent API, the same surface you can drive
with curl:

```sh
# what the bridge polls (agent API key; a plain long-poll from a cursor)
curl -H "Authorization: Bearer $RELAY_API_KEY" \
  "https://api.relayapp.im/v1/events?after=0&timeout=25"

# what the bridge sends per finished turn. The message_id is minted by the
# client and is the send's only retry key: repeating it is a replay.
curl -X POST https://api.relayapp.im/v2/conversations/cnv_…/messages \
  -H "Authorization: Bearer $RELAY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"message_id":"msg_01k1m9…","parts":[{"type":"text","text":"done"}]}'
```

- **Engines**: Claude and Codex are spawned as ACP adapters over
  stdio (`@agentclientprotocol/claude-agent-acp`,
  `@agentclientprotocol/codex-acp`). Both adapters are exact runtime
  dependencies resolved from the installed package; the bridge never runs
  mutable registry `latest` code. Adapter subprocesses receive platform and
  engine/provider variables, not the complete parent environment. Hermes is
  launched shell-free through its installed `hermes acp` stdio server and is
  checked with `hermes acp --check`. Conversation → session bindings persist
  in the paired account's runtime directory, so a conversation keeps its
  engine context. OpenClaw is deliberately separate: `install-openclaw`
  installs a native channel plugin into OpenClaw rather than pretending it is
  an ACP coding-engine preset.
- **Approvals**: an engine `session/request_permission` becomes a Relay
  message with a text part plus an `agent_permission_request` data part
  (origin-tagged Allow/Deny options). Tap an option or text
  `yes <id>` / `no <id>`. The full security-relevant tool input and affected
  paths must fit in the card; an operation that cannot be represented in full
  is denied instead of shown partially. No answer within 10 minutes → deny.
- **Owner gate**: only the pinned owner can prompt the engine or answer an
  approval card; messages from anyone else are ignored before their content is
  interpreted. An approval card carries the tool's raw input, so it is only
  ever posted in the conversation the owner's first message pinned — an ask
  raised anywhere else is routed there, and denied outright if there is no
  such conversation yet.
- **Reliability**: the receive cursor advances only in the same atomic
  (fsync + rename) write that persists the event queue
  (`~/.relaymessenger/accounts/<origin-agent-hash>/state.json`), event ids are deduped, rapid messages debounce
  ~800 ms into one turn, and the poll loop restarts with capped exponential
  backoff + jitter. Each pending approval is its own create-once file under
  that account's `approvals/`, so a bridge restart cannot lose one and no two
  processes ever rewrite a shared snapshot. Engine/tool turns are at-most-once:
  an attempt marker is durable before execution, so a crash never silently
  repeats a deploy, deletion, command, or external send. Completed replies use
  a durable outbox whose `msg_` id is persisted with the text, so delivery can
  retry without rerunning those tools and without sending twice. An
  interrupted turn is reported and must be retried explicitly by the owner.
- Polling is a plain pull, not a consumer session: it coexists with a webhook
  on the same agent, holds no exclusive slot, and a cursor that falls behind
  simply reads more events. A `401` stops the loop with re-pair guidance
  instead of retrying.
- **Codex notification privacy**: `install-codex` stores an explicit local
  allowlist entry for the current project root in
  `~/.relaymessenger/codex-notify.json`. A completed turn from any other project is
  suppressed. For an allowed project, Relay receives the project directory's
  basename plus Codex's complete `last-assistant-message`; input messages and
  the absolute working-directory path are not sent. That text is retained in
  Relay message history. There is no global-all-projects opt-in; run
  `install-codex` in each
  project you choose to disclose.
- **Codex MCP sends**: `relay_send_message` requires a caller-chosen stable
  `send_id`. Reuse the same `send_id`, conversation, and text only after an
  unknown outcome; a changed payload is rejected. The mapping and its `msg_`
  id live in the paired account's private runtime directory, so a process
  restart cannot turn one logical send into two messages.

## Development and testing

- `RELAY_API_ORIGIN` points `pair`, `start`, and `doctor` at a
  non-production Relay API origin, e.g. a local dev server:
  `RELAY_API_ORIGIN=http://127.0.0.1:8787 relaymessenger pair`. This is a
  development/testing mechanism only, production
  (`https://api.relayapp.im`) stays the default, the value must be an
  origin with no path/query/credentials, and plain HTTP is accepted only
  for loopback hosts (same rule as every other origin the bridge uses).
  Durable bridge state is scoped per effective origin, so an override
  never replays or advances production cursors and ledgers.
- With `--engine claude`, the bundled adapter inherits your Claude Code
  settings. If the resolved `permissions.defaultMode` is
  `bypassPermissions`, the engine never asks for approval, so phone
  Allow/Deny cards will not appear; `relaymessenger start` and `relaymessenger doctor`
  print a warning when they detect this.

## Files

```
~/.relaymessenger/config.json    agent API key, API origin, pinned owner (chmod 600)
~/.relaymessenger/codex-notify.json  locally allowed Codex project roots (not sent)
~/.relaymessenger/accounts/<hash>/state.json     cursor, queued events/replies,
                                           owner conversation (start-only)
~/.relaymessenger/accounts/<hash>/approvals/     one file per pending approval
~/.relaymessenger/accounts/<hash>/sessions.json  conversation → session bindings
~/.relaymessenger/accounts/<hash>/mcp-sends/     durable Codex MCP logical sends
~/.relaymessenger/accounts/<hash>/installed-plugins/  stable bundled plugin sources
```

Requires Node >= 22.18.
