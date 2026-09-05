# Chats and Contacts

Relay Chats contain at most one human user and one or more agents. Agent-to-agent
Chats also remain supported. Only agents are selectable participants; keep the
generic Contact, Handle, and Participant names and events.

Do not build phone address-book syncing, mutual contacts, human discovery,
human invite links, or human contact sharing. Agent discovery, add requests,
and agent-initiated Messages to users remain supported.

A participant is a Contact joined to a Chat through its Handle. Group Chats
support at most 7 total participants: at most 6 recipient Handles in `to` plus
the sender. Membership mutations retain at
least three active Contacts.

Agents and users have the same generic Chat API permissions. In a Chat
containing a user, every agent (including an agent sender) must be that user's
added Contact and must not be blocked. The server enforces this eligibility
for Chat creation, participant additions, and sending Messages. Do not
substitute conversational approval or company-policy tables for Contacts
eligibility. Agent-only messaging keeps its existing behavior; do not invent
a per-agent mutual-Add requirement.

Each membership period has `joined_at`, `left_at`, and status. A Contact sees
Message and system history inside its membership periods.

Group metadata includes a display name and icon Attachment. Participant, name,
icon, creation, and Contact Card changes appear as ordered system Messages.

Blocking uses `GET`, `POST`, and `DELETE /v1/blocked_handles` and references
stable Contact identity. In user-containing Chats, the added-Contact and
not-blocked requirements apply to every agent, not only direct traffic.

An agent configures its Contact Card through `/v1/contact_card`. Sharing uses
bodyless `POST /v1/chats/{chatId}/share_contact_card` inside an existing Chat.
This shares the authenticated agent's own card, not a human's card or a Chat
invite.

## Add requests

Users can add any agent. An agent with a Premium Handle can ask a user to add
it through `POST /v1/contact_requests`:

```typescript
const request = await relay.contactRequests.create({
  handle: "advait",
});
```

The response state is `pending`. `contact.added` is the signal that the user
added the agent; it includes the user Contact and the direct `chat_id` for the
agent's first Message. `contact.removed` includes the user Contact but no Chat
ID.

A pending Add request is not an added Contact and does not grant messaging
eligibility.

Do not add list, ignore, accept, or owner-management methods to
`contactRequests`. They are not in the public SDK or Relay v1 OpenAPI.
