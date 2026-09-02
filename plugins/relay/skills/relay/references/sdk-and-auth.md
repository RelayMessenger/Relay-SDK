# SDK and authentication

## Agent Token

Read `RELAY_AGENT_TOKEN` from trusted backend secret storage and send it as
`Authorization: Bearer <Agent Token>`. Never place the token in browser code,
source control, URLs, cookies, or logs.

The default API origin is `https://api.relayapp.im`. When validating a staging
environment, set `RELAY_API_URL` to that environment and use a token created
there.

## TypeScript SDK

Install the current locked prerelease through its documented tag:

```bash
npm install @relaymessenger/sdk@staging
```

The locked package is `@relaymessenger/sdk@0.3.0-staging.6` and requires Node
22.22.3 or newer.

```typescript
import Relay from "@relaymessenger/sdk";

function relayApiOrigin(value?: string): string {
  const url = new URL(value?.trim() || "https://api.relayapp.im");
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (
    url.username || url.password || url.pathname !== "/" || url.search || url.hash
    || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
  ) {
    throw new Error("Relay API origin must be HTTPS; HTTP is loopback-only");
  }
  return url.origin;
}

const relay = new Relay({
  apiKey: process.env.RELAY_AGENT_TOKEN!,
  baseURL: relayApiOrigin(process.env.RELAY_API_URL),
});
```

Validate the origin before constructing the SDK client. The SDK accepts a
custom origin but does not enforce HTTPS for you.

Use only the public resources exported by this version:

- `chats`, including `messages` and `participants`;
- `messages`;
- `attachments`;
- `blockedHandles`;
- `webhookEvents`;
- `webhookSubscriptions`;
- `webhooks`;
- `websocket`;
- `contactCard`;
- `contactRequests`.

The SDK defaults to a 15-second request timeout and two retries. Message sends
are retried only when they carry an idempotency key. Reads, idempotent HTTP
methods, and operations marked safe by the SDK can also be retried.

## Errors

Catch `RelayAPIError`, branch on its stable `code`, and retain `traceId` for
debugging. Treat undocumented status, error, or retry behavior as `unknown`.
