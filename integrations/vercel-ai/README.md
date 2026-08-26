# @relaymessenger/vercel-ai

Relay plugin for the [Vercel AI SDK](https://ai-sdk.dev): receive signed
`message.received` webhooks and post a model reply back to Relay as one
canonical message. Relay owns the messenger; your backend owns the model,
tools, and hosting. Raw HTTPS remains the canonical contract; this package
is a thin, dependency-free binding of it.

```ts
import { createRelay } from "@relaymessenger/vercel-ai";
import { generateText } from "ai";

const relay = createRelay({
  token: process.env.RELAY_AGENT_TOKEN!,
  webhookSecret: process.env.RELAY_WEBHOOK_SECRET!,
});

// Next.js: app/api/relay/route.ts
export const POST = relay.webhook(async ({ message, typing, reply }) => {
  await typing();
  const { text } = await generateText({
    model: "anthropic/claude-sonnet-5",
    prompt: message.parts.find((p) => p.type === "text")?.text ?? "",
  });
  await reply.text(text);
});
```

Relay has no draft bubble to stream into: one send is one finished message,
and message content is immutable once committed. So a streamed model result is
collected and posted once — `await reply.text(await result.text)` on a
`streamText` call does the same thing as the example above.

What the plugin enforces for you, per the public contract
(<https://docs.relayapp.im>):

- Standard Webhooks signature verification over the exact raw body.
- `event_id` deduplication per instance, recorded only after your handler
  succeeds; unknown event types acknowledge without dispatch.
- A client-minted `msg_` ULID on every send. That id is the message's identity
  and the send's only retry key: Relay replays a send carrying an id it already
  committed rather than committing it twice, and refuses another sender's claim
  on one with 409. There is no `Idempotency-Key` header. Pass `messageId` to
  `client.send` to reuse an id across your own retries.
- Fire-and-forget typing: `POST /v1/conversations/{id}/typing` with
  `{ started }`, no label and no lease. `typing(false)` takes it back down.

See the guide: <https://docs.relayapp.im/guides/vercel-ai-sdk>.
