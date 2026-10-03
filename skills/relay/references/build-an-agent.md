# Build an agent

One Python process that texts, answers calls, and tells its owner it works.
Python, because calls with your own speech-to-text, model and voice run on
Pipecat. Use [uv](https://docs.astral.sh/uv/); it installs Python 3.11+ itself.
TypeScript (`@relaymessenger/sdk`) has the same methods in camelCase.

## Create the agent

The person signs in once with `npx relaymessenger@latest login`. Create the
agent once; `--subtitle` (1 to 60 characters) is required and the handle is
generated when omitted. Then save its Agent Token without printing it:

```bash
npx relaymessenger@latest agents create --name "<name>" --subtitle "<one line about it>" --image ./picture.png --json
printf 'RELAY_AGENT_TOKEN=%s\n' "$(npx relaymessenger@latest auth token)" >> .env
uv init --bare && uv add relaymessenger python-dotenv
```

The new agent becomes the CLI's default profile, so `auth token` prints its
token. Never run `agents create` again to fix a picture; update the card.

```python
import os
from dotenv import load_dotenv
from relaymessenger import Relay

load_dotenv()
TOKEN = os.environ["RELAY_AGENT_TOKEN"]
relay = Relay(TOKEN)  # https://api.relayapp.im
```

## Set the profile picture

The picture is the photo on the agent's Contact Card. Make it with any image
model, save it as PNG or JPEG, and set it:

```bash
npx relaymessenger@latest contact-card update --image ./picture.png
```

From code, upload it and name the Attachment on the card:

```python
data = open("picture.png", "rb").read()
upload = await relay.attachments.create(filename="picture.png", content_type="image/png", size_bytes=len(data))
await relay.attachments.upload(upload, data)
card = (await relay.contact_card.retrieve())["contact_cards"][0]
await relay.contact_card.update(card["handle"], attachment_id=upload["attachment_id"])
```

## Text over the WebSocket

`run_websocket` holds the agent's event stream: it reconnects, sends the
heartbeat, and acknowledges each event when `on_event` returns. Run one per
agent, and only while it has no Webhook subscriptions.

```python
import asyncio
from relaymessenger.websocket import run_websocket

seen: set[str] = set()

async def on_event(event, context) -> None:
    if event["event_id"] in seen:  # Relay may deliver an event again
        return
    seen.add(event["event_id"])
    data = event["data"]
    if event["event_type"] == "message.received" and data["direction"] == "inbound":
        chat_id = data["chat"]["id"]
        text = "\n".join(p["value"] for p in data["parts"] if p["type"] == "text")
        if text:
            await relay.chats.start_typing(chat_id)
            reply = await model(chat_id, text)  # your LLM, with this chat's history and the persona
            await relay.chats.messages.send(chat_id, {"message": {
                "parts": [{"type": "text", "value": reply}],
                "idempotency_key": f"reply-{event['event_id']}",
            }})
    elif event["event_type"] == "call.created":
        ...  # calls.md#answer-a-call: start the call as a task, never await it here

async def on_full_sync(context) -> None:
    pass  # Relay could not replay: rebuild history from relay.chats if you keep it
```

Keep each Chat's history yourself and send it with the persona. In a group
Chat (`data["chat"]["is_group"]`) answer only messages meant for the agent.
Images, buttons and other parts: [messaging](messaging.md). Durable inboxes and
replay: [agent events](agent-events.md).

## Text the owner

When the process starts, text the agent's owner so they see it working. The
owner gets it in Chats, never as a message request:

```python
async def main() -> None:
    me = await relay.me.retrieve()             # GET /v1/me
    owner = me["owner_people"][0]["handle"]    # the person who owns the agent
    hello = await model_hello()                # the model's own words, in persona
    sent = await relay.messages.create(        # POST /v1/messages
        to=[owner],
        message={"parts": [{"type": "text", "value": hello}], "idempotency_key": f"hello-{STARTED_AT}"},
    )
    owner_chat_id = sent["chat_id"]            # keep it to call the owner
    await run_websocket(relay.base_url, TOKEN, on_event=on_event, on_full_sync=on_full_sync)

asyncio.run(main())
```

`STARTED_AT` is the process start time, so a restart texts again and a retry
does not.

## Run it

`uv run agent.py`, and keep it running in the background (`nohup uv run
agent.py > agent.log 2>&1 &`). Relay delivers events only while the WebSocket
is connected and holds them up to 30 days while it is not. Stop the old
process before starting a new one. Check `agent.log` and a reply to a text.
Next: [answer calls](calls.md#answer-a-call).
