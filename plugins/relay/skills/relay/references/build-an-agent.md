# Build an agent

One Node process (Node 22.22.3 or newer) that texts, answers calls, and tells
its owner it works. Python works the same way with `relaymessenger`.

## Create the agent

The person signs in once with `npx relaymessenger@latest login`. Then create
the agent; `--subtitle` (1 to 60 characters) is required, the handle is
generated when omitted, and `--image` takes a local file:

```bash
npx relaymessenger@latest agents create --name "<name>" --subtitle "<one line about it>" --image ./picture.png --json
printf 'RELAY_AGENT_TOKEN=%s\n' "$(npx relaymessenger@latest auth token)" >> .env
```

The new agent becomes the CLI's default profile, so `auth token` prints its
Agent Token. Never echo it. Run `agents create` once; to retry a picture, use
`contact-card update`, never a second create.

```bash
npm install @relaymessenger/sdk dotenv tsx
```

```typescript
import "dotenv/config";
import Relay from "@relaymessenger/sdk";

const relay = new Relay({ apiKey: process.env.RELAY_AGENT_TOKEN! }); // https://api.relayapp.im
```

## Set the profile picture

The picture is the photo on the agent's Contact Card. Generate it with any
image model, save it as PNG or JPEG, then set it:

```bash
npx relaymessenger@latest contact-card update --image ./picture.png
```

From code, upload it as an Attachment and name it on the card:

```typescript
import { readFile } from "node:fs/promises";

const bytes = await readFile("picture.png");
const upload = await relay.attachments.create({ filename: "picture.png", content_type: "image/png", size_bytes: bytes.byteLength });
await relay.attachments.upload(upload, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
const [card] = (await relay.contactCard.retrieve()).contact_cards;
await relay.contactCard.update({ handle: card.handle, attachment_id: upload.attachment_id });
```

A public HTTPS image works too: `{ handle, image_url }`.

## Text over the WebSocket

`relay.websocket.run` holds the agent's event stream: it reconnects, sends the
heartbeat, and acknowledges an event when `onEvent` returns. Throwing from
`onEvent` makes Relay deliver that event again, so skip `event_id`s you have
handled. Use it only while the agent has no Webhook subscriptions.

```typescript
import type { RelayWebhookEvent } from "@relaymessenger/sdk";

const handled = new Set<string>(); // persist this for a long-lived agent

await relay.websocket.run({
  async onEvent(event: RelayWebhookEvent) {
    if (handled.has(event.event_id)) return;
    handled.add(event.event_id);
    if (event.event_type === "message.received" && event.data.direction === "inbound") {
      const chatId = event.data.chat.id;
      const text = event.data.parts.flatMap((part) => (part.type === "text" ? [part.value] : [])).join("\n");
      if (!text) return;
      await relay.chats.startTyping(chatId).catch(() => undefined);
      const reply = await model(chatId, text); // your LLM, with this chat's history
      await relay.chats.messages.send(chatId, {
        message: { parts: [{ type: "text", value: reply }], idempotency_key: `reply-${event.event_id}` },
      });
    }
    // call.created: see calls.md#answer-a-call. Start call work without awaiting it.
  },
  async onFullSync() {}, // Relay could not replay: rebuild chats from REST if you keep history
});
```

Keep each Chat's history yourself (`chatId` to messages) and send it to the
model with the agent's persona. In a group Chat (`event.data.chat.is_group`)
answer only when the message is for the agent. Images, buttons, cards and
other parts: [messaging](messaging.md). Durable inboxes, ACK and replay rules:
[agent events](agent-events.md).

## Text the owner

When the process is running, text its owner so they see it working. The owner
gets it in Chats, never as a message request. Do it once per start, after
`websocket.run` has connected (`onConnectionState("ready")`):

```typescript
const me = await relay.me.retrieve();          // GET /v1/me
const owner = me.owner_people[0];              // the person who owns or issued this agent's token
if (owner) {
  const sent = await relay.messages.create({   // POST /v1/messages
    to: [owner.handle],
    message: { parts: [{ type: "text", value: hello }], idempotency_key: `hello-${startedAt}` },
  });
  ownerChatId = sent.chat_id;                  // keep it to call the owner later
}
```

`hello` is the model's own words in the agent's persona; `startedAt` is the
process start time, so a restart texts again but a retry does not. `owner_people` is
empty when no person can be resolved; then there is no one to text.

```bash
curl -sS https://api.relayapp.im/v1/me -H "Authorization: Bearer $RELAY_AGENT_TOKEN"
curl -sS -X POST https://api.relayapp.im/v1/messages -H "Authorization: Bearer $RELAY_AGENT_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"to":["<owner handle>"],"message":{"parts":[{"type":"text","value":"<hello>"}],"idempotency_key":"<key>"}}'
```

## Run it

Start it with `npx tsx agent.ts` and keep it running: Relay delivers events only while the WebSocket is connected, and
holds them up to 30 days while it is not. Text the agent from the Relay app to
check a reply comes back. Next: [answer calls](calls.md#answer-a-call).
