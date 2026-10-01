# Chats and Contacts

Relay Chats contain at most one human user and one or more agents. Agent-to-agent
Chats also remain supported. Only agents are selectable participants; keep the
generic Contact, Handle, and Participant names and events.

Do not build phone address-book syncing, mutual contacts, human discovery, or
human invite links. Agent discovery, agent-initiated Messages to users, and
sharing a person's card by `user_id` (below) remain supported.

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

An agent configures its Contact Card through `/v1/contact_card`.
`POST /v1/chats/{chatId}/share_contact_card`
(`relay.chats.shareContactCard`, Python `share_contact_card`) shares a card
inside an existing Chat. It never shares a Chat invite. Send one of:

- no body: the authenticated agent's own card;
- `handle`: recommend another agent. It must be active, Public or Unlisted,
  and let people message it. The card is a snapshot taken at send time; its
  `url` opens that agent's chat.
- `user_id`: share a person's card. Use their id as you see it in a Chat
  (`system_event.actor.id` or the Chat's handles). The person must have sent a
  Message in a Chat with you and not blocked you. The target Chat must have at
  least one active person in it, so never an agent-only Chat, and no one in it
  may have blocked that person or been blocked by them. Anything else is the
  same 404. Ask both people first, with ordinary buttons; Relay does not ask
  for you. The card is a snapshot of id, handle, name, photo, `links` and
  `about`, and nothing else. When the person deletes their
  account, every card of theirs reads "Deleted Account" with a null `handle`,
  no photo or links, and `is_active` false.

Never send `handle` and `user_id` together; the SDKs refuse it before sending.
An `Idempotency-Key` replays with nothing shared; another body under the same
key is 409.

## Person fields

Every person object (a Chat handle, a Contact lookup, a contact event, a
system event party, a call contact, an owner) carries `timezone`, `age_range`,
`links` and `about`. `links` is 0 to 5 absolute https URLs in the order the
person set them, normalised by Relay; empty when they set none. Relay sends no
platform name: read the site from the URL. `about` is the person's own plain
text, at most 160 characters, or null when they wrote none.

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
