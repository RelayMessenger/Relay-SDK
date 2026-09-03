# Trip planner agent

Add this agent to a group Chat and it plans the trip with you.

Someone mentions it — "@tripplanner three days in Lisbon in June, 800 each" —
and it answers with a day-by-day plan: where, when, who is coming, the budget,
then one part per day. The rest of the group keeps talking normally and the
agent says nothing, but it is reading. When somebody changes a constraint
("I can only do the 12th and the 13th") and mentions the agent again, it
rewrites the same plan around the new constraint and quotes the message that
changed it.

In a direct Chat it answers every Message, because there is nobody else to
talk to.

## Run

The agent needs two credentials and no others: a Relay Agent Token and an
Anthropic API key. Neither is ever written into the source.

An agent cannot have saved Webhook subscriptions while using this transport.
Use a dedicated Agent Token and an empty subscription list.

```sh
cp .env.example .env   # then fill it in, or export the same names

export RELAY_AGENT_TOKEN='<your Agent Token>'
export ANTHROPIC_API_KEY='<your Anthropic API key>'
export RELAY_API_URL='https://api.staging.relayapp.im'
export RELAY_STATE_PATH="$HOME/.relay/examples/trip-planner/state.db"

npm start --workspace @relaymessenger/cookbook-trip-planner-agent
```

Then create a group in Relay, add the agent, and mention it. Stop the process
with `SIGINT` or `SIGTERM`.

`RELAY_API_URL` must be an HTTPS origin; plain HTTP is accepted only for a
loopback development server. Omit it for production.

## How it works

The process holds the SDK's acknowledged WebSocket and does the work off it:

1. `onEvent` inserts the complete event into SQLite before it resolves. The SDK
   sends its acknowledgement only after that promise resolves, so Relay is told
   the event arrived only once it is on disk.
2. `event_id` is the deduplication key, so a replayed event is accepted once.
3. The inbox drains outside the socket callback. A model turn takes seconds; an
   acknowledgement must not wait for it.
4. Every inbound Message is remembered and marked Read, mentioned or not. Read
   states that the Message arrived. In a group Relay renders only Delivered, so
   a member's Read is invisible there anyway.
5. Only then does the mention gate run. In a group the agent answers when a
   text part's structured `mention` matches `chat.owner_handle` — the
   participant Relay marks `is_me`. Typing the characters "@tripplanner" into a
   Message is not a mention and does not start a turn.
6. While the model works, the agent holds a typing indicator, refreshing it
   every five seconds because the indicator expires.
7. The answer is one Message of ordered text parts, with `reply_to` pointing at
   the Message that asked, and
   `relay-example:trip-planner:<event_id>` as its idempotency key.

The plan written for an event is committed before the send. A retried send
therefore replays the same body under the same key, and the model is asked
once per event — never twice, and never for a second opinion Relay would
reject as an idempotency conflict.

`onFullSync` means events were missed, so the transcript the agent remembers
has a hole in it. It rebuilds every Chat's thread from `chats.listChats()` and
`chats.messages.list()` and commits that in one transaction before the stream
resumes. The agent's own Messages are left out; what it decided lives in the
saved plan.

The state file holds the group's conversation. Its directory is created `0700`
and the database `0600`, and it is bound to a non-secret fingerprint of the
Agent Token plus the API origin, so a second agent cannot resume the first
agent's plans. The webhook-receiver and websocket-agent recipes carry a
hardened `openat` path check for the same file; use theirs when the process
runs somewhere another user can write.

## What it does not know

The agent has no search, no browser, no calendar and no booking system. It
plans from what the group said and nothing else. Anything unsettled comes back
as a question under "Still to decide" rather than an invented price, address or
opening time.

## Replace the model

[`src/model.ts`](src/model.ts) is the only file that knows which model wrote
the plan. It calls `claude-sonnet-5` with `output_config.format`, so the API
returns the plan shape directly and there is no response parsing to repair.
Implement `TripPlanner` against any other provider and nothing else changes.

## Validate

```sh
npm run check --workspace @relaymessenger/cookbook-trip-planner-agent
npm run build --workspace @relaymessenger/cookbook-trip-planner-agent
npm test  --workspace @relaymessenger/cookbook-trip-planner-agent
```

The tests mock the model and the Relay boundary. They prove the group mention
gate, that an unmentioned Message is remembered and unanswered, that a changed
constraint rewrites the saved plan and quotes the Message that changed it, and
that a retried send does not ask the model a second time.
