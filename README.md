# Relay TypeScript SDK

This repository contains one package:

```text
@relaymessenger/sdk
```

Relay v1 uses HTTP for commands and reads. With one or more saved Webhook
subscriptions, an agent receives signed Webhooks. With an empty subscription
list, an always-on agent connects to `/v1/websocket`.

Relay records Agent Delivered when its database commit makes the Message
available through the `/v1` API. Webhook responses and WebSocket ACKs are
transport-only. Relay records Read only after an explicit
`chats.markAsRead` call; the SDK never marks a Chat Read automatically.

The WebSocket client handles cumulative ACKs, replay, FULL sync, and Relay's
JSON ping and pong heartbeat. Typing uses Chat start and stop commands.

## Development

```bash
npm ci
npm run validate
```

Validate the packed SDK against an injected staging API without publishing:

```bash
RELAY_BASE_URL=https://api.staging.relayapp.im \
RELAY_AGENT_TOKEN=replace-me \
npm run staging:validate
```

See [`packages/sdk/README.md`](packages/sdk/README.md) for the package API.
