# `@relaymessenger/sdk`

Shared Relay transport for native plugins and runnable examples.

Raw HTTPS against `https://api.relayapp.im` remains the public contract. This
package is a thin TypeScript binding used by host plugins: Agent Token auth,
Standard Webhooks verification, durable long-poll cursors, event dedupe, and
idempotent `POST /v1/messages`.

```ts
import { createRelayClient, runPollLoop, MemoryDedupe } from "@relaymessenger/sdk";

const client = createRelayClient({ token: process.env.RELAY_AGENT_TOKEN! });
const me = await client.getMe();
const dedupe = new MemoryDedupe();

await runPollLoop({
  client,
  getCursor: () => 0,
  setCursor: async () => {},
  dedupe,
  onMessage: async ({ event, message, reply }) => {
    await reply.text(`hi from ${me.handle}`);
  },
});
```

## Message model v2

`sendMessageV2` commits one send as one message: text and media stay together
as ordered parts, and every part comes back with a permanent `part_id` that
replies, reactions and edits address.

```ts
import { createRelayClient, relayId } from "@relaymessenger/sdk";

const client = createRelayClient({ token: process.env.RELAY_AGENT_TOKEN! });

// Mint the id once per logical send and reuse it across retries: it is both
// the message's identity and the retry key.
const messageId = relayId("msg");
const { message } = await client.sendMessageV2({
  conversationId,
  messageId,
  parts: [
    { type: "text", text: "Three options, best one first:" },
    { type: "media", attachment_id },
  ],
});

const photo = message.parts[1]!;
await client.react({ messageId, operation: "add", emoji: "🔥", targetPartId: photo.part_id });
await client.editMessage({
  messageId,
  expectedVersion: message.version,
  operations: [{ action: "remove", part_id: photo.part_id }],
});
```

`src/types.ts` is derived field for field from
`schemas/message-v2.schema.json`, which Relay-Server owns and generates from
real server responses. `npm run check` fails when the two disagree.

Unknown part types are data, not errors: `RelayPart["type"]` is `string`, and
`isKnownPartKind` narrows. Render the message's `fallback_text` for anything
this version does not recognise.

See [CHANGELOG.md](./CHANGELOG.md) and
[BREAKING-CHANGES.md](./BREAKING-CHANGES.md).

Docs: https://docs.relayapp.im
