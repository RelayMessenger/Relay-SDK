---
name: relay
description: Build or troubleshoot Relay v1 messaging integrations. Use for Relay SDK, Webhook, WebSocket, CLI, or skill work.
---

# Relay v1

Use the locked contract, not memory.

## Route

- Contract, routes, fields, events: read [the locked reference](references/relay-v1-lock.json) and the
  locked `contracts/relay-v1-openapi.yaml` first. Report hash or source drift.
- Messaging, buttons, list pickers, rich cards, carousels, forms, payments,
  places, threads and voice memos: read [messaging](references/messaging.md).
- Chats, contacts, sharing a card, person fields and chat activity: read
  [chats and contacts](references/chats-and-contacts.md).
- Audio and video calls, call events, and Pipecat, LiveKit or avatar
  integrations: read [calls](references/calls.md).
- `GET /v1/me`, who can message the agent, Log in with Relay, and the hosted
  MCP server's tools: read [agent settings](references/agent-settings.md).
- Searching the public agent directory: read [directory](references/directory.md).
- Webhooks, WebSocket, ACK, replay, and sync: read [agent events](references/agent-events.md).
- Tokens, environments, retries, errors, and the TypeScript and Python SDKs:
  read [SDK and auth](references/sdk-and-auth.md).
- CLI setup, profiles, connection, sending any message part, other resource
  commands, or skill installation: read [CLI and skills](references/cli-and-skills.md).

Read only the reference needed for the task. Use docs MCP for discovery when
available; the lock and OpenAPI remain authoritative.

## Rules

- Never invent a route, field, event, package, migration, or product rule.
- Mark behavior not proven by the contract or repository as `unknown`.
- Prefer `@relaymessenger/sdk` for TypeScript and `relaymessenger` for Python;
  show cURL for HTTP examples.
- Keep Agent Tokens in trusted backend storage and use credentials from the
  matching environment.
- For integration changes, test the real boundary: signatures over raw bytes,
  durable commit before ACK/2xx, duplicate events, idempotent replies,
  reconnect/replay, and relevant direct/group messages.

## Rating requests

To ask a person to rate your agent, send only `{"type":"rating_request"}` as
the message part. Read [ratings](references/ratings.md) for TypeScript, Python,
CLI and bridge examples and `rating.created`, `rating.updated`, `rating.deleted`.
Do not call person-only rating endpoints with an Agent Token.
