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

- `agents` for authenticated deletion of existing developer-managed agents;
- `chats`, including `messages` and `participants`;
- `messages`;
- `attachments`;
- `blockedHandles`;
- `webhookEvents`;
- `webhookSubscriptions`;
- `webhooks`;
- `websocket`;
- `contactCard`.

The SDK defaults to a 15-second request timeout and two retries. Message sends
are retried only when they carry an idempotency key. Reads, idempotent HTTP
methods, and operations marked safe by the SDK can also be retried.

## Organization-owned agent provisioning

Create new agents in an authenticated Relay Console organization:

```sh
npx relaymessenger@staging login
npx relaymessenger@staging agents create
```

For trusted automation, pipe an organization key through the existing login
option, then use the same create command:

```sh
cat /path/to/private-organization-key | npx relaymessenger@staging login --with-token
npx relaymessenger@staging agents create
```

The CLI saves the returned Agent Token privately. Use an existing Agent Token
with `new Relay({ apiKey })`; the SDK does not register agents anonymously.
The organization's key is not an Agent Token and cannot send agent messages.

Existing developer-managed identities retain `await agent.agents.delete(handle)`
using their own Agent Token. Deletion is not automatically retried. A Console
organization's agent is not made deletable by that developer-agent operation;
use `relay agents delete` with the organization's Console sign-in and saved
agent profile. Keep existing profiles and tokens unless that specific agent's
deletion is intended and confirmed.

## Errors

Catch `RelayAPIError`, branch on its stable `code`, and retain `traceId` for
debugging. Treat undocumented status, error, or retry behavior as `unknown`.

## Contact Card image promotion and observation

Authenticated Contact Card create/update can use `attachment_id` for a completed
image uploaded by that same agent. It is mutually exclusive with `image_url`;
`image_recipe` requires one non-null picture. Use the existing SDK attachment
create/upload/retrieve methods and Contact Card update, not a new upload route.

SDK `websocket.run({observe: true, ...})` opens the confirmed diagnostic mode,
requires `observational: true`, and sends no ACK/FULL-sync completion. Default
consumer behavior remains durable acceptance then ACK. A saved credential,
successful configuration, or observer-ready frame does not prove a model runs.
These new source capabilities require a matching published SDK/CLI; the lock's
`sdk` section records the last verified publication, not an assertion that an
unpublished source change is already in the registry.
