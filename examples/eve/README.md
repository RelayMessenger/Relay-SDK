# Relay as an eve channel

`relay.ts` here is a template, not a workspace. Copy it into an eve project at
`agent/channels/relay.ts`. eve's Chat SDK channel bridges any Vercel Chat SDK
adapter to an agent, so Relay reaches eve through
`@relaymessenger/chat-sdk-adapter` rather than through a bespoke channel.

## Install

```bash
npm install eve@latest chat @relaymessenger/chat-sdk-adapter @chat-adapter/state-memory
```

`chat` is a peer dependency of the adapter: install it yourself and keep one
copy in the tree.

## Environment

| Variable               | Where it comes from                                          |
| ---------------------- | ------------------------------------------------------------ |
| `RELAY_AGENT_TOKEN`    | Shown once when the agent is created. Starts with `rly_live_`. |
| `RELAY_WEBHOOK_SECRET` | Returned by `POST /v1/webhooks`. Starts with `whsec_`.        |

The adapter reads both from the environment when they are not passed
explicitly, so `createRelayAdapter()` with no arguments works once they are set.

## Point Relay at the route

eve mounts one `POST` route per adapter at `/eve/v1/{adapterName}`. The template
names the adapter `relay`, so the route is `/eve/v1/relay`. Register that URL as
the agent's webhook endpoint:

```bash
curl -X POST https://api.relayapp.im/v1/webhooks \
  -H "Authorization: Bearer $RELAY_AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://your-app.vercel.app/eve/v1/relay","events":["message.received"]}'
```

Keep the `whsec_` secret from that response: it is shown once, and the adapter
verifies every delivery against it.

Then deploy:

```bash
eve deploy
```

## What to expect

- `streaming: false` is deliberate. Relay commits one canonical message per
  turn, so the reply posts once when the turn completes rather than editing a
  partial bubble into place.
- In a group, Relay delivers a message to an agent only when that agent was
  invoked, and the reply is scoped to that single-use invocation. The adapter
  carries the invocation id into the first reply of the turn for you.
- Human-in-the-loop cards deliver as text. Relay has no interactive components,
  so the buttons do not render and a person cannot answer the prompt in the app.
