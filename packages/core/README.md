# `@relaymessenger/core`

Shared Relay transport for native plugins and runnable examples.

Raw HTTPS against `https://api.relayapp.im` remains the public contract. This
package is a thin TypeScript binding used by host plugins: Agent Token auth,
Standard Webhooks verification, durable long-poll cursors, event dedupe, and
idempotent `POST /v1/messages`.

```ts
import { createRelayClient, runPollLoop, MemoryDedupe } from "@relaymessenger/core";

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

Docs: https://docs.relayapp.im
