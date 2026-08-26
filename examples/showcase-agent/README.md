# Showcase agent

Forkable custom Relay agent. Polls `GET /v1/events`, marks read, replies with
one text message, and stops typing.

## Setup

```bash
# from the Relay-SDK repo root
cp examples/showcase-agent/.env.example examples/showcase-agent/.env
# put your Agent Token in .env or export RELAY_AGENT_TOKEN

npm ci
npm start -w @relaymessenger/showcase-agent
```

Then open the Relay app, open the conversation with your agent, and send a
message. You should get `Echo from @handle: …`.

Owner-only by default when `owner_user_id` is present on `GET /v1/agents/me`.

## Why long-poll

Webhooks need a public HTTPS URL. Long polling works on a laptop with no
tunnel. An Agent Token may use only one of the two transports at a time.
