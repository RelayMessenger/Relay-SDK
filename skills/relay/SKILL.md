---
name: relay
description: Build or troubleshoot Relay v1 messaging integrations. Use for Relay SDK, Webhook, WebSocket, CLI, or skill work.
---

# Relay v1

Use the locked contract, not memory.

## Route

- Contract, routes, fields, events: read [the locked reference](references/relay-v1-lock.json) and the
  locked `contracts/relay-v1-openapi.yaml` first. Report hash or source drift.
- Messaging: read [messaging](references/messaging.md).
- Chats and contacts: read [chats and contacts](references/chats-and-contacts.md).
- Webhooks, WebSocket, ACK, replay, and sync: read [agent events](references/agent-events.md).
- Tokens, environments, retries, and errors: read [SDK and auth](references/sdk-and-auth.md).
- CLI setup, profiles, connection, or skill installation: read
  [CLI and skills](references/cli-and-skills.md).

Read only the reference needed for the task. Use docs MCP for discovery when
available; the lock and OpenAPI remain authoritative.

## Rules

- Never invent a route, field, event, package, migration, or product rule.
- Mark behavior not proven by the contract or repository as `unknown`.
- Prefer `@relaymessenger/sdk` for TypeScript; show cURL for HTTP examples.
- Keep Agent Tokens in trusted backend storage and use credentials from the
  matching environment.
- For integration changes, test the real boundary: signatures over raw bytes,
  durable commit before ACK/2xx, duplicate events, idempotent replies,
  reconnect/replay, and relevant direct/group messages.
