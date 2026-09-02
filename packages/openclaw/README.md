# Relay for OpenClaw

`@relaymessenger/openclaw-plugin` is the native Relay channel for OpenClaw
`2026.8.1`.

Source is maintained in
[`RelayMessenger/Relay-SDK`](https://github.com/RelayMessenger/Relay-SDK/tree/main/packages/openclaw)
under `packages/openclaw`.

It connects an OpenClaw gateway to Relay with a Relay Agent Token. Relay
delivers events over its v1 WebSocket, and the plugin sends replies through
the Relay v1 REST Message API. The plugin imports `@relaymessenger/sdk`; it
does not contain a copied Relay client or protocol implementation.

## Install

```bash
openclaw plugins install @relaymessenger/openclaw-plugin
```

Configure the default account:

```json
{
  "channels": {
    "relay": {
      "enabled": true,
      "tokenFile": "/run/secrets/relay-agent-token"
    }
  }
}
```

For a single account, `RELAY_AGENT_TOKEN` is also supported. Use
`RELAY_BASE_URL` only when the Agent Token belongs to a non-production Relay
environment.

One OpenClaw gateway can back multiple Relay Contacts:

```json
{
  "channels": {
    "relay": {
      "defaultAccount": "default",
      "accounts": {
        "default": {
          "tokenFile": "/run/secrets/relay-default"
        },
        "support": {
          "tokenFile": "/run/secrets/relay-support"
        }
      }
    }
  }
}
```

Do not reuse one Agent Token in two configured accounts. Channel-level
`token`, `tokenFile`, and `RELAY_AGENT_TOKEN` credentials belong only to the
default account. Every named account must set its own inline token or
`tokenFile`; named accounts never inherit default credentials.

## Relay vocabulary and scope

- A **Contact** is a Relay user or agent profile.
- Each Contact owns a public **Handle**.
- A **Chat** is direct or group.
- A **Message** belongs to one Chat and contains ordered parts.

The plugin starts OpenClaw turns for every inbound user-authored
`message.received` event in a direct Chat. In a group Chat, it starts a turn
only when a text part's canonical `mention` Handle matches the canonical
`chat.owner_handle`, or when `reply_to.message_id` resolves through Relay to a
Message authored by this agent in the same Chat. Visible `@handle` text is not
parsed as a mention. Unmentioned group traffic, agent-authored Messages,
reactions, typing events, receipts, and membership events are durably accepted
without starting a turn.

Text, link, and media parts are rendered into agent-visible text. Media stays
a labeled signed URL; the plugin does not upload or send media.

Outbound support is deliberately limited to text Messages and Message reply
references. OpenClaw splits text at Relay's current 10,000-character text-part
limit. Reactions, edit, unsend, native threads, rich cards, and outbound media
are not declared.

`allowFrom` optionally limits inbound turns to exact Relay Contact IDs or
Handles:

```json
{
  "channels": {
    "relay": {
      "tokenFile": "/run/secrets/relay-agent-token",
      "allowFrom": [
        "alice",
        "00000000-0000-7000-8000-000000000001"
      ]
    }
  }
}
```

Without `allowFrom`, any user Contact whose Message Relay delivers to this
agent can start a direct turn, while the group activation rules above still
apply.

## Durable delivery

For every WebSocket event, the plugin:

1. inserts `event_id` into OpenClaw's channel ingress queue, or its private
   SQLite queue when a local/npm-pack install does not have trusted host state;
2. returns from the SDK callback only after that transaction commits;
3. lets the SDK send the cumulative WebSocket ACK;
4. dispatches a stored event through OpenClaw's ingress lifecycle.

A replayed `event_id` reaches the existing pending, completed, or failed row
and does not repeat model or tool work. The SDK owns sequence validation,
cumulative ACKs, reconnect replay, and JSON heartbeat ping/pong.

When Relay requires `full_sync`, the plugin pages through every visible Chat
and every visible Message, atomically replaces its local snapshot, and returns
only after the snapshot commits. The SDK then sends
`full_sync_complete`.

Relay Webhooks and the WebSocket are exclusive. Startup checks that the Agent
has no saved Webhook subscriptions. The SDK also treats WebSocket HTTP `409`
and close code `4410` as terminal `RelayWebhookConfiguredError` failures.

Final OpenClaw replies use the native durable outbound Message adapter. Each
REST send carries a stable idempotency key derived from OpenClaw's delivery
queue ID and part index. Unknown-send reconciliation repeats the exact text
chunks with the same keys, so Relay returns the original Message or commits
it once.

## Development

Use Node.js `22.22.3` or newer. Build and test on Linux:

```bash
npm install
npm run validate
npm run pack:smoke
npm run gateway:harness
```

`npm run release:validate` runs all three commands. CI and the guarded manual
staging workflow use that full sequence. The staging workflow accepts only an
exact SHA selected from the `staging` branch, the matching
`x.y.z-staging.n` package version, and the `staging` npm tag. It retains the
validated tarball and publishes that same digest with npm provenance; its
publish job is also bound to the `staging` GitHub environment.

`gateway:harness` packs the plugin, installs the tarball with OpenClaw
`2026.8.1`, inspects the managed installation, starts a real OpenClaw gateway,
connects to a loopback Relay WebSocket, receives one Message, and proves the
durable ACK and idempotent REST reply.

## Contract lock

`contracts/relay-v1.lock.json` records the compatibility boundary used by this
release: Relay Server
`ddcbccb44b9f85e8c2e3e63fead9b81d52f2bd15`, OpenAPI SHA-256
`26a6bc047286e09df6ef95f3c6b09f0437260ecc94e12c5fb3ce1704910f8ba1`,
public `ChatHandle.image_url` and `ChatHandle.about` fields with no legacy
aliases,
and the exact `@relaymessenger/sdk@0.3.0-staging.6` registry integrity, source
commit `d3a8ae02143120868e304e3a1213148e53eac80b`, REST operations, and WebSocket
frames consumed by the plugin.

Public CI hashes the checked-in `contracts/relay-openapi.yaml` fixture and
requires the locked digest above. The retained private release receipt also
sets `RELAY_SERVER_SOURCE_DIR` to an exact checkout of Server `ddcbccb44b9f`
and proves that the fixture bytes exactly match the locked Server commit before
packaging. The public Relay-SDK monorepo does not require credentials for the
private Server source and does not overstate what npm metadata can attest.

`contracts/relay-sdk-0.3.0-staging.6.registry.json` records immutable npm
publication metadata and tarball digests. Validation downloads the registry
tarball, verifies SHA-1, SHA-256, and SHA-512 integrity, checks the installed
SDK, and compares its package metadata with exact SDK commit `d3a8ae0`. The
npm SLSA statement binds the published tarball digest to that commit through
the trusted staging publish workflow. These are artifact compatibility and
source-provenance checks, not a claim of a hosted Relay deployment test.
