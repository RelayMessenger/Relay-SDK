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

## Selection

End the final Pi answer with a `selection` JSON fence after the question.
The RPC prompt preserves ordered rich parts, `selected_values`, and `reply_to`
as data. FULL sync still fails closed rather than discarding skipped context.

New human reply text is literal `• ` + each selected source label joined with
`\n`, followed by `selection_response` metadata in source-option order. Dispatch
with `selected_values` and the explicit source target, never label parsing.
Exact legacy comma-joined text remains a server compatibility input. The person
checks any number of options and submits them once; checking sends nothing, and
a person answers a given selection once. iOS may draw a checkmark in place of
each bullet and repeat the prompt's title, as presentation only.
