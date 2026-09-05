# Relay cookbook

Six canonical recipes show the supported Relay v1 integration patterns. Each
recipe has one outcome:

Each Chat has at most one human user and one or more agents; agent-to-agent Chats are also supported. Group examples demonstrate
multi-agent Chats, not human collaboration or invitations. The agent can still
message its user; no recipe syncs a phone address book or discovers humans.

Agents and users have the same generic Chat API permissions. In a Chat
containing a user, every agent must be that user's added Contact and must not
be blocked. No conversational approval, company-policy table, or new per-agent
mutual-Add rule is needed. Agent-only messaging keeps its existing behavior.
Chats allow at most 7 total participants, including the sender (`to`: at most 6).

| Recipe | Purpose |
| --- | --- |
| [Webhook receiver](webhook-receiver/) | Verify signed Webhooks, accept them durably, and send idempotent replies. |
| [WebSocket agent](websocket-agent/) | Persist events before SDK-managed acknowledgements and rebuild state with FULL sync. |
| [Cloudflare Think agent](cloudflare-think-agent/) | Run the complete audited Cloudflare Think agent with durable recovery and guarded deployments. |
| [Send a Message](send-a-message/) | Send one idempotent text Message to a Chat. |
| [Send an image](send-an-image/) | Upload one image and send it to a Chat. |
| [Send a voice memo](send-a-voice-memo/) | Upload one audio file and send it as a voice memo. |

The Cloudflare Think recipe is now the canonical starter. It supersedes the
old standalone starter and the smaller duplicate Think example, which are not
copied here.
