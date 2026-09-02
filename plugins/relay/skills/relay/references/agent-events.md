# Agent events

Each event envelope contains:

- `api_version: "v1"`;
- `webhook_version: "2026-08-30"`;
- `event_type` and stable `event_id`;
- `created_at`;
- top-level `trace_id` for request and delivery debugging;
- receiving `agent_id`;
- event-specific `data`.

## Webhooks

At least one saved webhook subscription selects Webhook delivery. Creating the
first subscription closes connected agent sockets and drains pending events to
Webhooks without changing `event_id`.

Create, list, update, and delete subscriptions only through the
`/v1/webhook-subscriptions` operations in the locked OpenAPI.

Verify Standard Webhooks over the exact raw request body. Persist the envelope
under a unique `event_id`, commit, then return `2xx`. Process model work and
REST replies afterward.

Relay makes one initial attempt plus up to ten retries. Retryable outcomes are
network failures, `429`, and `5xx`, with a 10-second response window and
delays of `2s`, `4s`, `8s`, `16s`, `32s`, `64s`, `128s`, `256s`, `512s`,
and `600s`. Operators can redrive a dead event from Console for 72 hours.
Terminal delivery rows remain in PostgreSQL for 30 days.

Treat redirects as terminal and never follow them. Reject destinations that
resolve to localhost, private, link-local, or cloud metadata addresses at
delivery time. Webhook retries can repeat an `event_id`, so duplicate
acceptance must not repeat side effects.

## WebSocket

Connect to `wss://api.relayapp.im/v1/websocket` with
`Authorization: Bearer <agent token>` on the upgrade request. Relay delivers the
same event envelope inside sequenced event frames.

WebSocket is the path when the agent has no saved Webhook subscriptions. A
subscription makes the upgrade return HTTP `409`. There is no mode, toggle, or
WebSocket setting.

Persist the complete event and dedupe `event_id` in one durable transaction.
Return from the SDK callback so it can send the cumulative ACK through the
highest consecutive sequence durably accepted. Run model work, tools, and REST
replies afterward from the durable inbox. Multiple sockets for one agent share
one checkpoint.

When Relay sends `full_sync`, rebuild canonical state through paginated REST
Chat and Message reads. Commit the complete snapshot and checkpoint together,
then send `full_sync_complete` for the exact required sequence. Resume event
ACKs after that commit.

Relay sends a ping every 30 seconds and closes the socket after 60 seconds
without a pong. The shared `/v1/websocket` path also serves users;
authentication determines the Contact kind. Public developer integrations use
an Agent Token.

Use the SDK's public `websocket.run` method. Do not add a private transport
adapter or a second receive mechanism.

## Path changes

Deleting the last webhook subscription drains pending events to WebSocket.
Creating the first drains them to Webhooks and closes all agent sockets. Relay
never sends one event through both paths.

If no subscription and no socket exists, events wait durably. Pending and
terminal event delivery state remains available for 30 days. Path changes
preserve `event_id`.

## ACK and Message receipts

A Webhook `2xx` and a WebSocket cumulative ACK are transport acknowledgements.
They end a delivery attempt or advance the replay checkpoint only.

For an agent recipient, Relay records Delivered when its database commit makes
the Message readable through the Relay v1 API. Transport acknowledgement does
not create Delivered or Read state. Read is optional and advances only through
`POST /v1/chats/{chatId}/read`.

## Typing

Start or refresh typing with `POST /v1/chats/{chatId}/typing`; stop with
`DELETE` on the same path. Refresh around 60 seconds; Relay clears the signal
around 90 seconds.

`chat.typing_indicator.started` and `.stopped` data contain `chat_id` and the
authenticated `contact` with `id`, `handle`, and `kind`. `trace_id` remains once
at the event-envelope level.
