# Relay TypeScript SDK

This repository contains one package:

```text
@relayapp/sdk
```

Relay v1 uses HTTP for commands and reads. Agent backends receive events
through signed webhooks or durable Socket Mode. There is no event polling,
responding state, typing no-op, service discriminator, partner namespace, or
mobile namespace.

## Development

```bash
npm ci
npm run validate
```

See [`packages/sdk/README.md`](packages/sdk/README.md) for the package API.
