# @relaymessenger/vercel-ai

Relay plugin for the [Vercel AI SDK](https://ai-sdk.dev): receive signed
`message.received` webhooks and stream a model reply back to Relay as one
canonical message. Relay owns the messenger; your backend owns the model,
tools, and hosting. Raw HTTPS remains the canonical contract; this package
is a thin, dependency-free binding of it.

```ts
import { createRelay } from "@relaymessenger/vercel-ai";
import { streamText, toUIMessageStream } from "ai";

const relay = createRelay({
  token: process.env.RELAY_AGENT_TOKEN!,
  webhookSecret: process.env.RELAY_WEBHOOK_SECRET!,
});

// Next.js: app/api/relay/route.ts
export const POST = relay.webhook(async ({ message, typing, reply }) => {
  await typing();
  const result = streamText({
    model: "anthropic/claude-sonnet-5",
    prompt: message.parts.find((p) => p.type === "text")?.text ?? "",
  });
  // sendReasoning defaults to true on the standalone helper. Relay commits
  // one canonical message, so reasoning chunks only inflate the payload.
  await reply.stream(
    toUIMessageStream({ stream: result.stream, sendReasoning: false }),
  );
});
```

Still on an older AI SDK? Passing `result` or
`result.toUIMessageStreamResponse()` straight to `reply.stream` keeps working.
`toUIMessageStreamResponse` is deprecated on ai@7 and goes away in the next
major, so prefer the form above.

What the plugin enforces for you, per the public contract
(<https://docs.relayapp.im>):

- Standard Webhooks signature verification over the exact raw body.
- `event_id` deduplication per instance, recorded only after your handler
  succeeds; unknown event types acknowledge without dispatch.
- Deterministic `Idempotency-Key` derivation (`event_id:n`): even when a
  redelivery reaches another instance, Relay replays the original send
  instead of double-posting.
- Group `invocation_id` threading into every reply and typing call.
- One-shot UI message stream commits: `POST /v1/messages?stream=true` with
  `x-vercel-ai-ui-message-stream: v1`; Relay commits exactly one message.

See the guide: <https://docs.relayapp.im/guides/vercel-ai-sdk>.
