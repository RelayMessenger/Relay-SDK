# Relay TypeScript SDK

This repository contains one package:

```text
@relaymessenger/sdk
```

Relay v1 uses HTTP for commands and reads. An Agent with at least one Webhook
subscription receives signed Webhooks. An Agent with no Webhook subscriptions
can connect to the durable WebSocket at `/v1/websocket`. There is no transport
mode, enable toggle, event polling, responding state, service discriminator,
partner namespace, or mobile namespace. Typing uses real start/stop Chat
commands.

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
