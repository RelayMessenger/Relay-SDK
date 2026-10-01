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

- `access` for the agent's Always Allow and Never Allow lists;
- `agents` for authenticated deletion of existing developer-managed agents;
- `attachments`;
- `blockedHandles`;
- `calls`, with the media transport in `@relaymessenger/sdk/calls`;
- `chats`, including `messages`, `participants` and `location`;
- `contactCard`;
- `contacts` for handle lookup;
- `directory`;
- `me` for `GET /v1/me`;
- `messages`;
- `oauth2Client` for Log in with Relay;
- `paymentRequests`;
- `webhookEvents`;
- `webhookSubscriptions`;
- `webhooks`;
- `websocket`.

`verifyRelayIdToken` checks a Log in with Relay ID token (`RELAY_USER_ID_CLAIM`
names its Relay id claim), and
`@relaymessenger/sdk/login-button` exports `RelayLoginButton`. A route in the
locked OpenAPI with no SDK method uses plain HTTP with the same token.

The SDK defaults to a 15-second request timeout and two retries. Message sends
are retried only when they carry an idempotency key. Reads, idempotent HTTP
methods, and operations marked safe by the SDK can also be retried.

## Python SDK

`pip install relaymessenger` (Python 3.10 or newer; the `calls` and `login`
extras add Calls and ID token checks). Every operation an Agent Token may call
has an async method named as the TypeScript SDK names it, in snake case:
`relay.chats.startTyping` is `relay.chats.start_typing`, and
`relay.paymentRequests` is `relay.payment_requests`. Request fields are keyword
arguments, except `chats.create(body)` and `chats.messages.send(chat_id, body)`,
which take the request body as a dict. Answers are the API's JSON as typed
dicts.

Every person-visible string below (`reply_text`, `question_text`,
`button_labels`, a place's `name`) is text the model writes for this
conversation; never send a fixed string. Every send takes its own idempotency
key, minted once per logical operation and saved before the request, so a
retry reuses it and a new send never replays an old one.

```python
import os

from relaymessenger import Relay, parts

relay = Relay(
    os.environ["RELAY_AGENT_TOKEN"],
    base_url=os.environ.get("RELAY_API_URL", "https://api.relayapp.im"),
    webhook_secret=os.environ.get("RELAY_WEBHOOK_SECRET"),
)


async def tour(
    chat_id: str,
    message_id: str,
    recipient_handle: str,
    reply_text: str,  # the model writes it
    question_text: str,  # the model writes it
    button_labels: list[str],  # the model writes them
    place: dict,  # latitude, longitude and name the model chose
    png: bytes,
    keys: dict[str, str],  # one saved idempotency key per operation
) -> None:
    me = await relay.me.retrieve()
    await relay.messages.create(
        to=[recipient_handle], message={"parts": [parts.text_part(reply_text)]}, idempotency_key=keys["reply"],
    )
    await relay.chats.messages.send(chat_id, {"message": {
        "parts": [parts.text_part(question_text), parts.buttons_part([{"label": label} for label in button_labels])],
        "idempotency_key": keys["question"],
    }})
    await relay.chats.messages.send(chat_id, {"message": {
        "parts": [parts.place_part(place["latitude"], place["longitude"], name=place["name"])],
        "idempotency_key": keys["place"],
    }})
    upload = await relay.attachments.create(filename="map.png", content_type="image/png", size_bytes=len(png))
    await relay.attachments.upload(upload, png)
    await relay.chats.messages.send(chat_id, {"message": {
        "parts": [parts.media_part(attachment_id=upload["attachment_id"])], "idempotency_key": keys["image"],
    }})
    await relay.messages.add_reaction(message_id, operation="add", type="love")
    await relay.messages.retrieve(message_id)
    await relay.messages.list_messages_thread(message_id, limit=50)
    await relay.chats.start_typing(chat_id)
    await relay.chats.stop_typing(chat_id)
    await relay.chats.mark_as_read(chat_id)
    await relay.chats.location.request(chat_id)
    await relay.chats.location.retrieve(chat_id)
    await relay.contacts.lookup(handle=recipient_handle)  # or id=..., or task=...
    await relay.contact_card.retrieve(handle=me["handle"])
    await relay.blocked_handles.list()
    await relay.payment_requests.list(status="requested")
    await relay.webhook_events.list()
    await relay.webhook_subscriptions.list()
```

The resources are `chats` (with `messages`, `participants` and `location`),
`messages`, `attachments`, `payment_requests`, `calls`, `contacts`,
`contact_card`, `directory`, `blocked_handles`, `access`, `agents`, `me`,
`oauth2_client`, `webhook_events`, `webhook_subscriptions`, `webhooks` and
`websocket`. `relaymessenger.parts` types every message part and builds the
simple ones: `text_part` (with `mention`), `media_part`, `link_part`,
`buttons_part`, `place_part` and `payment_part`; `selection`, `form` and
`rich_cards` build the structured ones.

Verify a webhook over the raw body with the subscription's `whsec_` secret:

```python
from relaymessenger import WebhookVerificationError

try:
    event = relay.webhooks.unwrap(raw_body, headers=request_headers)
except WebhookVerificationError:
    ...  # answer 400 and do not process the delivery
```

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
