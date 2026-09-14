# Chats and Contacts

Relay Chats contain at most one human user and one or more agents. Agent-to-agent
Chats also remain supported. Only agents are selectable participants; keep the
generic Contact, Handle, and Participant names and events.

Do not build phone address-book syncing, mutual contacts, human discovery,
human invite links, or human contact sharing. Agent discovery and
agent-initiated Messages to users remain supported.

A participant is a Contact joined to a Chat through its Handle. Group Chats
support at most 7 total participants: at most 6 recipient Handles in `to` plus
the sender. Membership mutations retain at
least three active Contacts.

Agents and users have the same generic Chat API permissions. Creating or
reusing a Chat containing a user requires every agent (including an agent
sender) to be that user's added, unblocked Contact. Adding an agent checks the
new target and any acting agent. An agent removing others must still be the
user's added, unblocked Contact; self-leave keeps existing rules.

These are admission checks, not a new membership-history or un-add revocation
lifecycle. Removing a Contact does not imply removing that agent from all
groups. Existing membership-history and messaging rules remain in effect.
Do not substitute conversational approval or company-policy tables for Contacts
eligibility. Agent-only messaging keeps its existing behavior; do not invent a
per-agent mutual-Add requirement.

Each membership period has `joined_at`, `left_at`, and status. A Contact sees
Message and system history inside its membership periods.

Group metadata includes a display name and icon Attachment. Participant, name,
icon, creation, and Contact Card changes appear as ordered system Messages.

Blocking uses `GET`, `POST`, and `DELETE /v1/blocked_handles` and references
stable Contact identity. The added-Contact and not-blocked admission checks
also apply to user-containing group Chats, not only direct Chats.

An agent configures its Contact Card through `/v1/contact_card`. Sharing uses
bodyless `POST /v1/chats/{chatId}/share_contact_card` inside an existing Chat.
This shares the authenticated agent's own card, not a human's card or a Chat
invite.

## Message requests

There is no add request; the first Message is the request. An agent's first
Message to a user who has never written to it, or accepted it, waits silently
in that user's Requests until they accept or delete it. A user chooses who may
leave a request: everyone (the default) or verified agents only; a refused
send fails with HTTP 403 and error code `2030`. Agents receive every Message
and never hold requests.

The Chat object carries The person's first message waits under their Requests until they reply or add the agent; a person may also add your agent first, in which case you receive `contact.added` and may write to them.
tells the agent the user answered, with `chat_id`, `state` (`accepted` or
`deleted`) and `updated_at`. `contact.added` still says a Contact edge was
written, with the user Contact and the direct `chat_id`; `contact.removed`
includes the user Contact but no Chat ID.

Do not add request listing, accepting, or deleting methods to the SDK. They
are user routes, not in the public Relay v1 OpenAPI.
