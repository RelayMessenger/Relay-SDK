# Relay CLI

`@relaymessenger/cli` is the official terminal client for the current Relay
v1 Agent API. It delegates all Relay calls and response types to
`@relaymessenger/sdk`.

Source is maintained in
[`RelayMessenger/Relay-SDK`](https://github.com/RelayMessenger/Relay-SDK/tree/main/packages/cli)
under `packages/cli`.

## Install

```sh
npm install --global @relaymessenger/cli
relay --version
```

Node.js 22.22.3 or newer is required. `relaymessenger` remains an executable
alias for existing installs.

## Authenticate

Create Agent Tokens in Relay Console. Tokens are accepted only from stdin,
the `RELAY_AGENT_TOKEN` environment variable, or an owner-only local profile;
there is deliberately no token command-line option.

```sh
printf '%s' "$RELAY_AGENT_TOKEN" | relay auth login --token-stdin
relay auth status
relay doctor
```

Profiles live in `${XDG_CONFIG_HOME:-~/.config}/relay/config.json`. The
directory is mode `0700` and the file is mode `0600` on POSIX systems.

```sh
relay profiles add staging --api-url https://api.staging.relayapp.im
relay profiles use staging
printf '%s' "$STAGING_RELAY_AGENT_TOKEN" |
  relay auth login --profile staging --token-stdin
relay profiles list
```

Resolution order is:

1. `RELAY_AGENT_TOKEN`, `RELAY_API_URL`, and `RELAY_PROFILE`;
2. the selected local profile;
3. `https://api.relayapp.im` as the API URL.

Plain HTTP API URLs are rejected except for loopback development origins.

## Resource commands

Every command prints JSON.

```sh
relay chats list --limit 20
relay chats get "$CHAT_ID"
relay chats messages list "$CHAT_ID" --limit 50
relay chats messages send "$CHAT_ID" --text "Hello" \
  --idempotency-key "$(uuidgen)"
relay messages send --to advait --text "Hello" \
  --idempotency-key "$(uuidgen)"
relay messages react "$MESSAGE_ID" --operation add --type love
relay chats typing start "$CHAT_ID"
relay chats read "$CHAT_ID"

relay contact-card get
relay contact-card setup --handle weather.acme --first-name Weather
relay contact-card share "$CHAT_ID"
relay contact-requests create advait

relay attachments upload ./report.pdf --content-type application/pdf
relay blocked-handles list
relay webhooks events
relay webhooks subscriptions list
```

Run `relay --help` and each command group's `--help` for the full current
surface: Chats, Messages, Attachments, blocked Handles, webhook events and
subscriptions, Contact Cards, and Contact requests.

Chats contain one human user and one or more agents. Participant commands keep
their generic names; add an agent by its Handle:

```sh
relay chats participants add "$CHAT_ID" research.agent
relay chats participants remove "$CHAT_ID" research.agent
```

`contact-card share` shares the authenticated agent's own card.
`contact-requests create` asks a user to add the authenticated Premium Handle
agent; it is not a human invitation. Agent-initiated Messages to users remain
supported. There are no phone address-book, mutual-contact, human discovery,
or human invite-link commands.

## Local event forwarding

`relay events listen` is a development convenience backed only by the SDK's
source-backed Agent WebSocket. It refuses Relay's production API, requires an
explicit profile, and requires confirmation that the profile belongs to a
dedicated non-production Agent whose durable checkpoint may advance:

```sh
relay --profile staging events listen --acknowledge-events
relay --profile staging events listen --acknowledge-events \
  --forward-to http://127.0.0.1:3000/relay-events
```

Forward destinations must be loopback HTTP(S). Forwarded bodies are the
original Relay event envelopes but are **unsigned** and carry
`x-relay-dev-forwarded: 1`; this is not a substitute for testing Standard
Webhooks signature verification. A non-2xx local response is not acknowledged,
so Relay can redeliver it. Local receivers must deduplicate by `event_id`.

The listener refuses a FULL-sync request rather than falsely claiming it
rebuilt durable state. It also cannot run while the Agent has webhook
subscriptions because Relay makes those delivery modes exclusive. Never point
it at an Agent whose checkpoint is owned by another consumer.

## Doctor

`relay doctor` checks the Node runtime, API URL, token resolution, local file
permissions, SDK contract availability, and a read-only API request.
`relay doctor --offline` skips only the network request and is suitable for
package-install checks.

## Security

- Keep Agent Tokens out of source, URLs, shell arguments, and logs.
- Prefer secret-manager injection through `RELAY_AGENT_TOKEN` in automation.
- Output and error paths redact every locally resolvable token.
- This package has no coding-agent runtime, pairing flow, or hidden private
  API client.

## Development

All Linux execution happens in a fresh Daytona sandbox:

```sh
npm ci
npm run validate
```

`validate` performs type checking, unit and negative tests, the pinned SDK
operation-hash check, boundary checks, package packing, isolated tarball
installation, and installed-bin doctor smoke tests.
