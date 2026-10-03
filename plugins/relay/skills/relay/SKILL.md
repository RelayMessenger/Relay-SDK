---
name: relay
description: Build, run and debug agents on Relay, the messenger where people text and call AI agents. Use when creating a Relay agent, texting or calling its owner, setting its profile picture, answering or placing voice and video calls, or working with the Relay SDK, CLI, WebSocket, Webhooks or API.
---

# Relay

Relay carries Messages and Calls between people and agents. Your process is
the agent's brain: it reads events, decides, and answers through the Relay API.

## Build an agent people text and call

Do these in order. Each link has the canonical code; copy it, do not explore
the SDK source or the iOS app.

1. Create the agent and save its token: [build an agent](references/build-an-agent.md#create-the-agent).
2. Set its profile picture on its Contact Card: [profile picture](references/build-an-agent.md#set-the-profile-picture).
3. Run one process that reads its events over the WebSocket and texts back:
   [texting agent](references/build-an-agent.md#text-over-the-websocket).
4. When it runs, text its owner hello: [text the owner](references/build-an-agent.md#text-the-owner).
5. Answer calls in that same process and bridge the audio to any voice
   provider: [answer calls](references/calls.md#answer-a-call).
6. Send its own video on every call, from any frame source:
   [the agent's camera](references/calls.md#the-agents-camera).
7. When calls work, call its owner: [call a person](references/calls.md#call-a-person).

Finish each step by running it against Relay, not only by compiling.

## Route

- Contract, routes, fields, events: [the locked reference](references/relay-v1-lock.json)
  and `contracts/relay-v1-openapi.yaml`. Report hash or source drift.
- Messages, buttons, list pickers, rich cards, carousels, forms, payments,
  places, threads, voice memos: [messaging](references/messaging.md).
- Chats, contacts, sharing a card, person fields, chat activity:
  [chats and contacts](references/chats-and-contacts.md).
- Calls, call events, video, Rive, voice frameworks: [calls](references/calls.md).
- `GET /v1/me`, who can message the agent, Log in with Relay, hosted MCP:
  [agent settings](references/agent-settings.md).
- Public agent directory: [directory](references/directory.md).
- Webhooks, WebSocket, ACK, replay, sync: [agent events](references/agent-events.md).
- Tokens, environments, retries, errors, TypeScript and Python SDKs:
  [SDK and auth](references/sdk-and-auth.md).
- CLI commands and profiles, skill installation: [CLI and skills](references/cli-and-skills.md).
- Asking a person for a rating: [ratings](references/ratings.md).

Docs: https://docs.relayapp.im/llms.txt lists every page.

## Rules

- Never invent a route, field, event, package, or product rule. Mark behavior
  the contract does not prove as `unknown`.
- Prefer `@relaymessenger/sdk` for TypeScript and `relaymessenger` for Python.
- Keep tokens and API keys in `.env` or a secret store; never print them,
  commit them, or put them in command arguments.
- Use one API origin and token from the same environment for every request.
- Every person-visible string comes from the model; never send canned text.
