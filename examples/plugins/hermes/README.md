# Relay channel for Hermes Agent

Persistent Relay messaging for [Hermes Agent](https://hermes-agent.nousresearch.com),
shaped like Hermes' Photon iMessage channel in that it needs no public URL;
Relay reaches that with durable long polling instead of gRPC. Owner allowlist,
idempotent replies.

## Quick start

```bash
export RELAY_AGENT_TOKEN=rly_live_...
npm start -w @relaymessenger/hermes
```

Message your Relay agent from the iOS app. The default turn handler echoes;
replace `handleTurn` with a call into Hermes' agent runtime.

## Integrate with Hermes

1. Create a Relay agent and copy the Agent Token (shown once).
2. Put the token in `~/.hermes/.env` as `RELAY_AGENT_TOKEN`.
3. From your Hermes gateway process, call:

```ts
import { startHermesRelayChannel } from "@relaymessenger/hermes";

await startHermesRelayChannel({
  token: process.env.RELAY_AGENT_TOKEN!,
  handleTurn: async (ctx) => {
    // Hand ctx.message to Hermes, return the model reply text.
    return await runHermesTurn(ctx.message);
  },
});
```

Long polling and webhooks are mutually exclusive per Agent Token. This plugin
uses long polling so Hermes can run on a laptop or server without a tunnel.

## Status

| Piece | State |
| --- | --- |
| Long-poll transport via `@relaymessenger/core` | Shipped in this package |
| Owner allowlist default | Shipped |
| Idempotent text replies | Shipped |
| First-party Hermes gateway wizard (`hermes relay setup`) | Next. Open an issue if you want it prioritized |
