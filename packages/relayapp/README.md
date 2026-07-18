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
| `relayapp pair` | `POST /v1/pairings`, shows a terminal QR + code, long-polls until you claim it in the app, stores the Agent Token in `~/.relayapp/config.json` (chmod 600) and pins your user id as the bridge owner (from `GET /v1/agents/me`; override with `RELAY_OWNER_USER_ID`). The token never appears on the phone. |
| `relayapp start` | Receive loop: long-polls `GET /v1/events`, drives the engine over ACP, replies via `POST /v1/messages` with an `Idempotency-Key`. Flags: `--engine claude\|codex\|opencode`, `--dir <path>`, `--staging`. |
| `relayapp install-codex` | Merges — never clobbers — `[mcp_servers.relay]` + `notify` into `~/.codex/config.toml` (comments preserved; a `.bak` of the original is kept) and a `PermissionRequest` hook into `~/.codex/hooks.json`, so plain `codex` runs ping Relay on turn completion and route approvals to your phone. Codex gates untrusted hook handlers: the first run may ask you to trust the relayapp handler. |
| `relayapp install-claude` | Points at the Claude Code channel plugin (`integrations/claude-code`) when present; otherwise says so and falls back to `relayapp start`. |
| `relayapp doctor` | Checks node/npx, pairing, token file perms, API reachability, adapter resolvability, and durable-state health. |

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
  -H "Idempotency-Key: relay-turn-<sha256(conversation,last-event)>" \
  -H "Content-Type: application/json" \
  -d '{"conversation_id":"cnv_…","parts":[{"type":"text","text":"done"}]}'
```

- **Engines**: Claude and Codex are spawned as official ACP adapters over
  stdio (`@agentclientprotocol/claude-agent-acp`,
  `@agentclientprotocol/codex-acp` via `npx`). opencode is driven over its
  own HTTP API: the bridge spawns `opencode serve` (or attaches to an
  operator-run server via `OPENCODE_SERVER_URL` + basic auth), sends
  `prompt_async`, and consumes the SSE `/event` stream. Conversation →
  session bindings persist in `~/.relayapp/sessions.json`, so a conversation
  keeps its engine context.
- **Approvals**: an engine `session/request_permission` becomes a Relay
  message with a text part plus a `claude_permission_request` data part
  (origin-tagged Allow/Deny options and quick-reply chips). Tap a chip or text
  `yes <id>` / `no <id>`. No answer within 10 minutes → deny.
- **Owner gate**: only the user pinned at pair time can prompt the engine or
  answer an approval card; messages from anyone else are ignored before their
  content is interpreted.
- **Reliability**: the receive cursor advances only in the same atomic
  (fsync + rename) write that persists the event queue
  (`~/.relayapp/state.json`), event ids are deduped, rapid messages debounce
  ~800 ms into one turn, and the poll loop restarts with capped exponential
  backoff + jitter. Each pending approval is its own create-once file under
  `~/.relayapp/approvals/`, so a bridge restart cannot lose one and no two
  processes ever rewrite a shared snapshot.
- Long-poll is exclusive: an enabled webhook endpoint or a second poller gets
  `409` (Telegram semantics). One consumer per token. A `401` stops the loop
  with re-pair guidance instead of retrying.

## Files

```
~/.relayapp/config.json    agent token, API origin, pinned owner   (chmod 600)
~/.relayapp/state.json     cursor, queued events, owner conversation
                           (written only by `relayapp start`)
~/.relayapp/approvals/     one file per pending approval
~/.relayapp/sessions.json  conversation → engine session bindings
```

Requires Node >= 18. Staging: pass `--staging` to `pair`/`start`
(`https://api.staging.relayapp.im`).
