# Relay channel for Claude Code

Message your Claude Code session from your Relay agent conversation. This
plugin is an MCP stdio server implementing the Claude Code
[channels contract](https://code.claude.com/docs/en/channels-reference)
(research preview):

- **Inbound**: long-polls Relay `GET /v1/events` with your Agent Token and
  forwards the owner's messages into the session as
  `notifications/claude/channel` events
  (`<channel source="relay" chat_id="cnv_…" sender="usr_…">`).
- **Outbound**: a `reply` MCP tool that `POST /v1/messages` back into the
  conversation (with an `Idempotency-Key`, so retries never duplicate).
- **Permission relay**: when Claude Code opens a tool-approval dialog, the
  prompt is posted to your Relay conversation as a card with Allow/Deny
  options tagged with the request id. Tap an option, or text
  `yes <id>` / `no <id>`, and the verdict is returned as
  `notifications/claude/channel/permission`. The local terminal dialog stays
  live; the first answer wins.

## Requirements

- Node.js >= 22.18 (the server runs TypeScript natively) — or Bun
- A Relay agent and its Agent Token (Relay app → your agent → Agent Token)
- The agent must **not** have an enabled webhook endpoint: Relay's event
  stream is long-poll XOR webhook, and `GET /v1/events` returns
  `409 conflict` while a webhook is enabled

## Install

From a marketplace that lists this plugin:

```
/plugin install relay@<marketplace>
```

Then install the server's dependencies in the installed plugin directory
(where this README lives):

```
npm install --omit=dev
```

## Configure

Run `/relay:configure` for guided setup, or create
`~/.claude/channels/relay/.env` yourself:

```
RELAY_AGENT_TOKEN=<your agent token>
RELAY_BASE_URL=https://api.relayapp.im
# Pin the only user allowed to reach this session (usr_…). If unset, the
# owner is fetched from GET /v1/agents/me; if that also fails, the channel
# refuses to start.
#RELAY_OWNER_USER_ID=
# Explicit opt-in: pin the FIRST user who messages the agent as owner.
# Only use this for private agents you alone can message.
#RELAY_ALLOW_TOFU=1
```

Use `RELAY_BASE_URL=https://api.staging.relayapp.im` against staging. The
long-poll cursor and learned routing state persist in `state.json` in the same
directory.

## Run (research preview)

Channels are in research preview and custom channels are not on the approved
allowlist, so start Claude Code with the development flag:

```
# installed as a plugin
claude --dangerously-load-development-channels plugin:relay@<marketplace>

# or, registered as a bare MCP server in .mcp.json
claude --dangerously-load-development-channels server:relay
```

Claude Code shows a full-screen development-channels warning, then registers
the channel: messages you send to your agent in the Relay app appear directly
in the session.

## Security model

- **Sender gate (fail closed)**: only the agent's **owner** user id passes.
  The owner is resolved from `RELAY_OWNER_USER_ID` in `.env`, else from
  `owner_user_id` in `GET /v1/agents/me`. If neither is available the channel
  refuses to start — a stranger messaging a public agent can never silently
  become the session's owner. Trust-on-first-use pinning (first user sender
  becomes owner, persisted in `state.json`) is available only as an explicit
  opt-in via `RELAY_ALLOW_TOFU=1` and logs a warning when it pins. Every
  non-owner sender is dropped before any content reaches Claude — including
  permission verdicts.
- **Verdict interception, gated on open requests**: option taps and
  `yes <id>` / `no <id>` replies are consumed and emitted as verdict
  notifications **only while that request id is outstanding** (opened by a
  `permission_request`, closed by the first verdict, expired after 10
  minutes). Anything verdict-shaped without an open id — like the ordinary
  sentence "no worry" — falls through to Claude as normal chat, and an id can
  never be answered twice or after expiry.
- **Replay containment**: the cursor only advances past events whose
  notification was written to the session (a failed handoff keeps the cursor
  and retries), and a bounded persisted dedupe set of recent event ids stops
  a cursor reset or corrupt `state.json` from replaying the event log into
  Claude's context.
- **Untrusted display fields**: `description` and `input_preview` from
  permission requests are sanitized (bidi/invisible characters stripped,
  whitespace folded, length clamped) before being sent to Relay, on top of
  the client-side sanitization in Claude Code >= 2.1.211.
- The Agent Token stays in `~/.claude/channels/relay/.env` (never in chat, in
  the transcript, or in this repository).

## Wire contract notes

- `GET /v1/events?cursor=<n>&timeout=<1..30>&limit=<1..100>` →
  `{ events: [{ event_id, event_type, agent_id, created_at, data }], next_cursor }`;
  passing the cursor acknowledges everything at or below it (Telegram
  getUpdates model). Cursor is persisted after each processed batch.
- Inbound messages are `message.received` events whose `data.message` is the
  canonical Relay message; `chat_id` is `message.conversation_id`, `sender`
  is `message.sender.id`.
- The permission card is one Relay message with a text part (human-readable,
  includes the text fallback instructions) and a `data` part:
  `{ kind: "claude_permission_request", request_id, tool_name, description,
  input_preview, options: [{ id: "allow"|"deny", label, origin: { kind,
  request_id } }] }`. A tap reply arrives as a `data` part echoing the origin
  tag plus the chosen option; the text fallback matches
  `/^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i`.

## Development

```
npm install       # includes dev deps
npm run typecheck # tsc --noEmit
npm test          # node --test (unit tests, mocked Relay server)
```

## Verification status

- Verified: unit tests (event→notification mapping, verdict parsing — text and
  data-part tap, sender gating, permission card build, reply/long-poll client
  against a mocked Relay HTTP server) and `tsc --noEmit`.
- **Unverified**: live end-to-end channel run (`claude
  --dangerously-load-development-channels` against a deployed `GET /v1/events`).
  The long-poll endpoint ships on a parallel server branch and was not deployed
  when this plugin was built; run the loop against staging once it lands.
