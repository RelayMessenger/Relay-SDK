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
`/v1/webhook-subscriptions` operations in the locked OpenAPI. Read one with
`getWebhookSubscription`, `GET /v1/webhook-subscriptions/{subscriptionId}`
(`relay.webhookSubscriptions.retrieve(subscriptionId)`, Python
`webhook_subscriptions.retrieve(subscription_id)`).

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

WebSocket is the path when the agent has no saved Webhook subscriptions. A terminal event view may use the explicit read-only observer query `observe=true`; its ready frame must include `observational:true`. Observer connections send no ACK or FULL-sync completion, use transient cursors, and do not prove a model runtime is connected. A
subscription makes the upgrade return HTTP `409`. There is no saved transport toggle; the diagnostic observe query does not
change the delivery path.

Persist the complete event and dedupe `event_id` in one durable transaction.
Return from the SDK callback so it can send the cumulative ACK through the
highest consecutive sequence durably accepted. Run model work, tools, and REST
replies afterward from the durable inbox. Multiple consuming sockets for one agent share
one checkpoint. Observer connections instead use an independent transient cursor
and may see retained rows already completed by a consumer. They do not advance
delivery, count as a runtime, or promise durable replay.

When Relay sends `full_sync`, rebuild canonical state through paginated REST
Chat and Message reads. Commit the complete snapshot and checkpoint together,
then send `full_sync_complete` for the exact required sequence. Resume event
ACKs after that commit.

Send `{"type":"ping"}` every 30 seconds; Relay answers `{"type":"pong"}` at
the edge and closes a socket that is silent for 60 seconds. The shared `/v1/websocket` path also serves users;
authentication determines the Contact kind. Public developer integrations use
an Agent Token.

Use the SDK's public `websocket.run` method. For read-only terminal observation, use its confirmed observe option only; never wrap the ACKing consumer or invent HTTP event reads. Do not add a private transport
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

Relay records Delivered when it accepts and stores the Message, with one commit
timestamp for every recipient. Transport acknowledgement does not create
Delivered or Read state. Read is optional and advances only through
`POST /v1/chats/{chatId}/read`.

## Message events

`message.received` carries a person's Message. These carry the agent's own
Messages, with the same Message `data` (`id`, `chat`, `chat_id`, `direction`,
`from_handle`, `is_from_me`, `parts`, `sent_at`, `delivered_at`, `read_at`,
`reply_to`, `thread`):

- `message.sent`: Relay committed a Message the agent sent.
- `message.delivered`: Relay accepted and stored it for at least one
  recipient. A Message dropped for every recipient sends none.
- `message.read`: every recipient marked it Read.

`message.failed` says a committed Message could not reach a recipient agent.
Its `data` holds `chat_id`, `message_id`, `code`, `reason`, `detail_code` and
`failed_at`.

## Reaction events

`reaction.added` (added or replaced) and `reaction.removed` carry `chat_id`,
`message_id`, `part_index`, `reaction_type`, `custom_emoji` (set only when
`reaction_type` is `custom`), `from_handle`, `is_from_me` and `reacted_at`.

## Chat events

- `chat.created`: a Chat with the agent in it was created. `data` is the Chat:
  `id`, `display_name`, `group_chat_icon`, `handles`, `is_group`,
  `created_at`, `updated_at`.
- `participant.added` and `participant.removed`: `chat_id`, `participant`
  (a Chat handle), and `added_at` or `removed_at`.
- `chat.group_name_updated` and `chat.group_icon_updated`: `chat_id`,
  `old_value`, `new_value` (the name or icon URL; null when removed),
  `changed_by_handle` and `updated_at`.

## Typing

Start or refresh typing with `POST /v1/chats/{chatId}/typing`; stop with
`DELETE` on the same path. Refresh around 60 seconds; Relay clears the signal
around 90 seconds.

`chat.typing_indicator.started` and `.stopped` data contain `chat_id` and the
authenticated `contact` with `id`, `handle`, and `kind`. `trace_id` remains once
at the event-envelope level.

## Call events

`call.created`, `call.updated` and `call.ended` use the same envelope and path.
Join the room within 32 seconds of `call.created` to answer; keep the highest
`revision` per `call.id`. See [calls](calls.md).
