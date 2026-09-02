---
name: relay
description: Implement, debug, or review a Relay v1 agent backend, Webhook receiver, WebSocket consumer, messaging flow, or @relaymessenger/sdk integration.
---

# Relay v1

Use the locked Relay v1 contract instead of remembered examples.

## Ground truth

1. Read the [locked source record](references/relay-v1-lock.json).
2. Read the OpenAPI at the exact Relay Docs commit recorded there.
3. Read the relevant guide and implementation evidence when it is available in
   the workspace.
4. Use the bundled Relay docs MCP to find material, not to override the locked
   OpenAPI. If a search result disagrees with the lock, report the result as
   stale and do not use its route, field, event, or package.
5. Prefer `@relaymessenger/sdk` for TypeScript and show equivalent cURL when
   teaching an HTTP operation.

**Never invent a route, resource, field, event, package, or migration.** Label
unproved behavior `unknown`.

## Agent event path

Relay derives an agent's event path from saved Webhook subscriptions:

| Saved configuration | Path |
| --- | --- |
| One or more Webhook subscriptions | Webhooks |
| Zero Webhook subscriptions | WebSocket |

There is no transport mode or toggle. A socket upgrade while any subscription
exists returns HTTP `409`. Creating the first subscription closes connected
agent sockets; deleting the final subscription makes the WebSocket path
available. Read [Agent events](references/agent-events.md) before changing
subscriptions or connection code.

## Core model

Relay uses Contacts, Handles, Chats, Messages, parts, Attachments, reactions,
and per-recipient delivery state. A Contact has `kind: "user" | "agent"`.

For details, read only the reference needed:

- [Messaging](references/messaging.md) for sends, parts, Attachments, replies,
  reactions, mentions, and receipts.
- [Chats and Contacts](references/chats-and-contacts.md) for groups,
  membership periods, Add requests, blocks, Contact Cards, and history.
- [Agent events](references/agent-events.md) for Webhooks, WebSocket, ACK,
  path changes, FULL sync, typing, retries, and `trace_id`.
- [SDK and authentication](references/sdk-and-auth.md) for Agent Tokens,
  environments, the public TypeScript surface, retries, and errors.

## Verification

Prove the integration at its real boundaries:

- signature verification over raw webhook bytes;
- durable event commit before webhook `2xx` or WebSocket ACK;
- duplicate `event_id` handling;
- idempotent REST replies;
- reconnect/replay and FULL-sync behavior for WebSocket consumers;
- first-subscription and last-subscription path changes;
- Webhook SSRF and redirect handling;
- direct and group Message behavior relevant to the product.

Keep Agent Tokens in trusted backend storage. Use a staging API root only with
credentials created in that same environment.
