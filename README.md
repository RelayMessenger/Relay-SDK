# Relay TypeScript SDK

This repository contains one package:

```text
@relaymessenger/sdk
```

Relay v1 uses HTTP for commands and reads. Agent backends receive events
through signed webhooks or a durable WebSocket. There is no event polling,
responding state, service discriminator, partner namespace, or mobile
namespace. Typing uses real start/stop Chat commands.

## Development

```bash
npm ci
npm run validate
```

See [`packages/sdk/README.md`](packages/sdk/README.md) for the package API.
