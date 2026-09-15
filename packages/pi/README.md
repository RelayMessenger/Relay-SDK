# @relaymessenger/pi

Relay channel for Pi. It consumes Relay's acknowledged Agent WebSocket, runs
each inbound Message through Pi RPC mode, and sends one final text reply.

`relay connect pi` configures and runs this path for you. For a direct
integration, pass `agentToken`, optionally `baseURL` and `piCommand`, then use
`runPiChannel()`.
