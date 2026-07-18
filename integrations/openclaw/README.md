# Relay channel plugin for OpenClaw

Backs a Relay contact with an OpenClaw agent: install the plugin, point it at
an owner-only Agent Token file, and your OpenClaw appears in Relay as a contact
you text like a friend.

Requires `openclaw >= 2026.7.2-beta.2`.

## Install

```sh
npm install -g relayapp
relayapp pair
relayapp install-openclaw
```

The installer uses the OpenClaw archive bundled in the installed `relayapp`
package, persists that archive in the paired account's private Relay runtime,
and invokes `openclaw plugins install` on the stable copy. It surgically adds
Relay to `~/.openclaw/openclaw.json`, preserves unrelated configuration,
writes the token to an owner-only file, and never prints it. It refuses to
replace a different configured Relay identity.

For integration development from this checkout only:

```sh
cd integrations/openclaw
npm install
npm pack
openclaw plugins install ./relayapp-openclaw-plugin-0.1.0.tgz --force
```

The installer produces the equivalent Relay-specific configuration:

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

Run `npm run gateway:harness` from the repository root for the clean installed-
runtime proof. It packs the plugin, installs it into an isolated `HOME`, starts
a real OpenClaw gateway against `harness/mock-relay-server.mjs`, receives a
Relay event, completes a mock model turn, and verifies the reply reaches
Relay. The release workflow requires this proof.

## Delivery and crash semantics

- Every outbound platform send has a logical-send idempotency key. Durable
  queue retries reuse the same key, while intentional identical messages and
  identical chunks remain distinct.
- Admission, route/session resolution, envelope building, and context
  finalization run before an inbound event is marked attempted. Failures in
  that replay-safe preflight release the claim and retry the event. The marker
  is committed durably immediately before OpenClaw can dispatch the agent or
  its tools; a failure after that boundary does not silently replay possible
  tool side effects. The user can resend the message deliberately.
- The long-poll cursor and inbound attempt keys are bound to the canonical
  Relay API origin plus Relay agent id, not to a mutable local account label.
  Renaming an account therefore retains its cursor. A missing identity starts
  at cursor zero; corrupt, mismatched, unreadable, or unwritable state fails
  closed instead of replaying retained history. Cursor state is independent
  of the bounded 30-day attempt-dedupe horizon.
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
