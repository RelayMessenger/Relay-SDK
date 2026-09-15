# @relaymessenger/pi

Relay channel for Pi. It consumes Relay's acknowledged Agent WebSocket, runs
each inbound Message through Pi RPC mode, and sends one final text reply.

`relay connect pi` configures and runs this path for you. For a direct
integration, pass `agentToken`, optionally `baseURL` and `piCommand`, then use
`runPiChannel()`.

To load the native Pi extension in an existing Pi installation:

```bash
pi install npm:@relaymessenger/pi
```

Set `RELAY_AGENT_TOKEN` before using `/relay-connect`. Set
`RELAY_BASE_URL` when the Agent belongs to a non-default API environment.
