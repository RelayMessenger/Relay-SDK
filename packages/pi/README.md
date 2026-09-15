# relay-pi-channel

A bounded Relay channel that consumes Relay's acknowledged Agent WebSocket, runs each inbound message through Pi RPC mode, and sends one final text reply.

Configure `RELAY_AGENT_TOKEN`, optionally `RELAY_BASE_URL` and `PI_BIN`, then use `runPiChannel()`.
