# Relay channel plugin for OpenClaw

Backs a Relay contact with an OpenClaw agent: install the plugin, point it at
an owner-only Agent Token file, and your OpenClaw appears in Relay as a contact
you text like a friend.

Requires `openclaw >= 2026.7.2-beta.2`.

## Install from source

```sh
cd integrations/openclaw
npm install
npm pack            # builds dist/ via prepack
openclaw plugins install ./relayapp-openclaw-plugin-0.1.0.tgz --force
```

Write the token to an owner-only file without putting it in shell history:

```sh
mkdir -p ~/.openclaw/secrets
chmod 700 ~/.openclaw/secrets
# Use your editor to place only the Agent Token in this file.
chmod 600 ~/.openclaw/secrets/relay-agent-token
```

Then trust and configure the plugin in `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "allow": ["relay"],
    "entries": { "relay": { "enabled": true } }
  },
  "channels": {
    "relay": {
      "enabled": true,
      "tokenFile": "~/.openclaw/secrets/relay-agent-token",
      "baseUrl": "https://api.relayapp.im"
    }
  }
}
```

`RELAY_AGENT_TOKEN` / `RELAY_BASE_URL` are honored for the default account
when the config fields are absent. Multiple agents run as named accounts under
`channels.relay.accounts.<id>`, one token each.

## Sender security

Relay agents can be discoverable, so adding an agent as a contact is not an
authorization boundary. The plugin accepts inbound turns only from the
authenticated agent's `owner_user_id` returned by `GET /v1/agents/me` and any
Relay user ids the operator explicitly adds to `allowFrom`. Wildcards are
ignored. If neither an API owner nor an explicit allowlist is available, the
account fails closed and does not start polling.

## One consumer per token

Relay's `GET /v1/events` long poll allows **exactly one consumer per Agent
Token**:

- A newer poll takes the slot; the older consumer's request ends with
  `409 terminated_by_other_consumer`. Running this plugin and another
  long-poll consumer (for example `relayapp start`, or a second OpenClaw) on
  the same token makes them steal the slot from each other forever. Give each
  consumer its own agent/token.
- Long polling is **XOR with webhooks**: while a webhook endpoint is enabled
  for the agent, `/v1/events` returns `409 conflict` and the channel stops
  with a terminal disconnect. Disable or delete the agent's webhooks to poll.

The plugin also refuses to start a second configured account that resolves to
the same agent id as a running one.

## Config reference (per account)

| Field | Meaning |
| --- | --- |
| `token` / `tokenFile` | Agent Token (or file containing it) |
| `baseUrl` | Relay API origin (default `https://api.relayapp.im`). Remote origins must use HTTPS; HTTP is accepted only for loopback development. Paths, credentials, queries, and fragments are rejected. |
| `allowFrom` | Additional Relay user ids (`usr_…`) allowed alongside the API-pinned owner. These identities may also run control commands. Wildcards are ignored. |
| `pollTimeoutSeconds` | Long-poll hold time, 1–30 (default 30) |

## Harness

`harness/mock-relay-server.mjs` is a mock Relay API (agent identity, long-poll
events, idempotent sends, typing/read) plus a mock OpenAI-compatible model
endpoint used for the installed-runtime proof: point `channels.relay.baseUrl`
and a `models.providers` entry at `http://127.0.0.1:8790`, install the packed
plugin into an isolated `HOME`, and run `openclaw gateway`.
`MOCK_LLM_REPLY=short` switches the model reply to a single chunk.

## Delivery and crash semantics

- Every outbound platform send has a logical-send idempotency key. Durable
  queue retries reuse the same key, while intentional identical messages and
  identical chunks remain distinct.
- Before an inbound event can start an agent turn, its attempt marker is
  committed durably. A crash may interrupt that turn, but the event is not
  silently replayed because local tools may already have performed a deploy,
  deletion, shell command, or external send. The user can resend the message
  deliberately.
- Before polling, the plugin takes an atomic per-origin/per-agent filesystem
  lock under `~/.openclaw/relay/consumer-locks`. A second OpenClaw process
  fails closed; a lock whose recorded PID is dead is recovered on startup.
  Shutdown aborts the active long poll and releases both process-local and
  filesystem ownership before a replacement starts.
- Every API operation has a deadline (15 seconds for ordinary calls; the
  configured long-poll hold plus 15 seconds for event polling). Retrying a
  message send reuses its logical delivery idempotency key.

## v1 scope

Direct conversations, text only. Inbound media/voice render placeholder
lines until Relay's agent attachment download path ships; reactions are
observe-only; receipts (`message.delivered`/`message.read`) never start a
turn. Final agent replies are delivered durably (chunked to Relay's 8 KiB
per-part cap, idempotency-keyed, retry-safe).
