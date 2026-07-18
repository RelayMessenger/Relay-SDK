# Relay channel plugin for OpenClaw

Backs a Relay contact with an OpenClaw agent: install the plugin, paste an
Agent Token, and your OpenClaw appears in Relay as a contact you text like a
friend. Internal to the Relay repo — not published to npm or ClawHub.

Requires `openclaw >= 2026.7.2-beta.2`.

## Install (local npm-pack)

```sh
cd integrations/openclaw
npm install
npm pack            # builds dist/ via prepack
openclaw plugins install ./relayapp-openclaw-plugin-0.1.0.tgz --force
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
      "token": "<Agent Token from the Relay app>",
      "baseUrl": "https://api.relayapp.im"
    }
  }
}
```

`RELAY_AGENT_TOKEN` / `RELAY_BASE_URL` are honored for the default account
when the config fields are absent. Multiple agents run as named accounts under
`channels.relay.accounts.<id>`, one token each.

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
| `baseUrl` | Relay API origin (default `https://api.relayapp.im`) |
| `dmPolicy` | `open` (default — Relay DMs are already scoped to users who added the contact) or `allowlist` |
| `allowFrom` | Relay user ids (`usr_…`). In `allowlist` mode, only these senders are dispatched; an empty list denies. Senders listed here are also the only ones allowed to run control commands. |
| `pollTimeoutSeconds` | Long-poll hold time, 1–30 (default 30) |

## Harness

`harness/mock-relay-server.mjs` is a mock Relay API (agent identity, long-poll
events, idempotent sends, typing/read) plus a mock OpenAI-compatible model
endpoint used for the installed-runtime proof: point `channels.relay.baseUrl`
and a `models.providers` entry at `http://127.0.0.1:8790`, install the packed
plugin into an isolated `HOME`, and run `openclaw gateway`.
`MOCK_LLM_REPLY=short` switches the model reply to a single chunk.

## v1 scope

Direct conversations, text only. Inbound media/voice render placeholder
lines until Relay's agent attachment download path ships; reactions are
observe-only; receipts (`message.delivered`/`message.read`) never start a
turn. Final agent replies are delivered durably (chunked to Relay's 8 KiB
per-part cap, idempotency-keyed, retry-safe).
