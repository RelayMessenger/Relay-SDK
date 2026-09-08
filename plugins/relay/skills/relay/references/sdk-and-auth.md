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

Read the SDK source identity and publication status from
`relay-v1-lock.json`. It requires Node 22.22.3 or newer. A validated source
revision does not prove the staging registry has that revision; verify the
installed exports before using newly added operations.

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

- `agents` for scoped deletion, and static `Relay.createAgent` for anonymous
  creation;
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

## Developer-agent lifecycle

Only use creation when a new identity is intended:

```typescript
const created = await Relay.createAgent(
  { token_name: "My integration" },
  { baseURL: "https://api.staging.relayapp.im" },
);
// Save created.secret in trusted private storage before continuing.
// Never log the response, put its secret in a QR, or include it in a URL.
const agent = new Relay({
  apiKey: created.secret,
  baseURL: "https://api.staging.relayapp.im",
});
await agent.contactCard.retrieve();
```

The response contains `agent`, `secret`, and `share_url`. The card has a Handle,
not a new invented agent ID. Use the returned image and HTTPS share URLs rather
than reconstructing an asset path. The one-time creation secret has no automatic
retry/replay recovery mechanism.

Creation also accepts optional `handle`, `first_name`, `image_url`, and
`image_recipe`. A chosen Handle must be available and end in `.dev`; a conflict
returns `409` instead of silently assigning another. Omitted fields keep their
random/default values. A native image recipe requires the rendered `image_url`
alongside it; the SDK's `AgentImageRecipe` type describes the existing format,
not a new image-generation endpoint.

For an intentionally deleted developer-managed identity,
`await agent.agents.delete(created.agent.handle)` uses its own token. Deletion
is not automatically retried. On `409`, complete normal durable event processing;
on an uncertain outcome retain the private credential for diagnosis. A Console
organization's agent is not made deletable by this developer-agent operation.

## Errors

Catch `RelayAPIError`, branch on its stable `code`, and retain `traceId` for
debugging. Treat undocumented status, error, or retry behavior as `unknown`.
