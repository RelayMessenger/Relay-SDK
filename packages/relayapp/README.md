# relayapp

Message your local coding agent from your phone. `relayapp` bridges a Relay
agent conversation to Claude Code, Codex, or opencode running on this
machine: texts become prompts, replies come back as messages, and tool
approvals arrive as Allow/Deny cards you answer with a tap.

Relay is messaging for agents — https://relayapp.im. API reference:
https://docs.relayapp.im.

## Quickstart

```sh
npm install -g relayapp

# 1. Pair this machine with the Relay app (QR + short code, ~30 s)
relayapp pair

# 2. Start the bridge in the repo you want the agent to work in
cd ~/code/my-project
relayapp start --engine claude    # or: --engine codex | --engine opencode
```

Now text the agent from the Relay app. Each message (or quick burst of
messages) becomes one engine turn; the bridge shows a typing indicator while
the engine works and posts one finalized reply per turn.

## Commands

| Command | What it does |
| --- | --- |
| `relayapp pair` | `POST /v1/pairings`, shows a terminal QR + code, long-polls until you claim it in the app, stores the Agent Token in `~/.relayapp/config.json` (chmod 600) and pins your user id as the bridge owner (from `GET /v1/agents/me`; override with `RELAY_OWNER_USER_ID`). If owner lookup is interrupted after the token is saved, running the command again resumes that saved token without creating another agent. The token never appears on the phone. |
| `relayapp start` | Receive loop: long-polls `GET /v1/events`, drives the engine over ACP, replies via `POST /v1/messages` with an `Idempotency-Key`. Flags: `--engine claude\|codex\|opencode`, `--dir <path>`. |
| `relayapp install-codex` | Run from a project root to opt in that project only. Merges — never clobbers — `[mcp_servers.relay]` + `notify` into `~/.codex/config.toml` (comments preserved; a `.bak` of the original is kept) and a `PermissionRequest` hook into `~/.codex/hooks.json`. Other projects are suppressed until installed separately. Codex gates untrusted hook handlers: the first run may ask you to trust the relayapp handler. |
| `relayapp install-claude` | After pairing, strictly validates the Claude plugin bundled in the installed npm package, persists its local marketplace under the paired account's private runtime directory, installs `relay@relayapp-bundled`, and writes the token/API origin/owner pin to `~/.claude/channels/relay/.env` with mode 600 without printing the token. It refuses to overwrite a different configured identity. |
| `relayapp install-openclaw` | After pairing, persists and installs the OpenClaw plugin archive bundled in the npm package, adds only Relay's plugin/channel fields to `~/.openclaw/openclaw.json`, and writes the paired token to an owner-only file. Existing unrelated config is preserved and a different configured identity is refused. |
| `relayapp doctor` | Checks Node, pairing, token file permissions, API reachability, installed adapter pins, and durable-state health. |

## How the wire works

Everything rides Relay's public agent API — the same surface you can drive
with curl:

```sh
# what the bridge polls (agent bearer auth; long-poll, cursor acks ≤ N)
curl -H "Authorization: Bearer $AGENT_TOKEN" \
  "https://api.relayapp.im/v1/events?cursor=0&timeout=25"

# what the bridge sends per finished turn
curl -X POST https://api.relayapp.im/v1/messages \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  -H "Idempotency-Key: relay-turn-<sha256(conversation,event-id-batch)>" \
  -H "Content-Type: application/json" \
  -d '{"conversation_id":"cnv_…","parts":[{"type":"text","text":"done"}]}'
```

- **Engines**: Claude and Codex are spawned as official ACP adapters over
  stdio (`@agentclientprotocol/claude-agent-acp`,
  `@agentclientprotocol/codex-acp`). Both adapters are exact runtime
  dependencies resolved from the installed package; the bridge never runs
  mutable registry `latest` code. Adapter subprocesses receive platform and
  engine/provider variables, not the complete parent environment. opencode is driven over its
  own HTTP API: the bridge spawns `opencode serve` (or attaches to an
  operator-run server via `OPENCODE_SERVER_URL` + basic auth), sends
  `prompt_async`, and consumes the SSE `/event` stream. Conversation →
  session bindings persist in the paired account's runtime directory, so a conversation
  keeps its engine context.
- **Approvals**: an engine `session/request_permission` becomes a Relay
  message with a text part plus a `claude_permission_request` data part
  (origin-tagged Allow/Deny options and quick-reply chips). Tap a chip or text
  `yes <id>` / `no <id>`. The full security-relevant tool input and affected
  paths must fit in the card; an operation that cannot be represented in full
  is denied instead of shown partially. No answer within 10 minutes → deny.
- **Owner gate**: only the user pinned at pair time can prompt the engine or
  answer an approval card; messages from anyone else are ignored before their
  content is interpreted.
- **Reliability**: the receive cursor advances only in the same atomic
  (fsync + rename) write that persists the event queue
  (`~/.relayapp/accounts/<origin-agent-hash>/state.json`), event ids are deduped, rapid messages debounce
  ~800 ms into one turn, and the poll loop restarts with capped exponential
  backoff + jitter. Each pending approval is its own create-once file under
  that account's `approvals/`, so a bridge restart cannot lose one and no two
  processes ever rewrite a shared snapshot. Engine/tool turns are at-most-once:
  an attempt marker is durable before execution, so a crash never silently
  repeats a deploy, deletion, command, or external send. Completed replies use
  a durable outbox and stable idempotency key, so delivery can retry without
  rerunning those tools. An interrupted turn is reported and must be retried
  explicitly by the owner.
- Long-poll is exclusive: an enabled webhook endpoint or a second poller gets
  `409` (Telegram semantics). One consumer per token. A `401` stops the loop
  with re-pair guidance instead of retrying.
- **Codex notification privacy**: `install-codex` stores an explicit local
  allowlist entry for the current project root in
  `~/.relayapp/codex-notify.json`. A completed turn from any other project is
  suppressed. For an allowed project, Relay receives the project directory's
  basename plus Codex's complete `last-assistant-message`; input messages and
  the absolute working-directory path are not sent. That text is retained in
  Relay message history. There is no global-all-projects opt-in; run
  `install-codex` in each
  project you choose to disclose.
- **Codex MCP sends**: `relay_send_message` requires a caller-chosen stable
  `send_id`. Reuse the same `send_id`, conversation, and text only after an
  unknown outcome; a changed payload is rejected. The mapping and
  idempotency key live in the paired account's private runtime directory, so
  a process restart cannot turn one logical send into two messages.

## Files

```
~/.relayapp/config.json    agent token, API origin, pinned owner   (chmod 600)
~/.relayapp/codex-notify.json  locally allowed Codex project roots (not sent)
~/.relayapp/accounts/<hash>/state.json     cursor, queued events/replies,
                                           owner conversation (start-only)
~/.relayapp/accounts/<hash>/approvals/     one file per pending approval
~/.relayapp/accounts/<hash>/sessions.json  conversation → session bindings
~/.relayapp/accounts/<hash>/mcp-sends/     durable Codex MCP logical sends
~/.relayapp/accounts/<hash>/installed-plugins/  stable bundled plugin sources
```

Requires Node >= 22.18.
