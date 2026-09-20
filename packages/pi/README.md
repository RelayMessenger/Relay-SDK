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

## Selection, coming soon

These are local candidate sources, not a claim that the published package or
hosted API supports selection yet.

End the final Pi answer with a `selection` JSON fence after the question.
The RPC prompt preserves ordered rich parts, `selected_values`, and `reply_to`
as data. FULL sync still fails closed rather than discarding skipped context.

New human reply text is literal `• ` + each selected source label joined with
`\n`, followed by `selection_response` metadata in source-option order. Dispatch
with `selected_values` and the explicit source target, never label parsing.
Exact legacy comma-joined text remains a server compatibility input. Tapping a
selected option deselects it locally; the sole submit action is a centered
compact light-blue Send button. iOS checked circles are presentation only.
