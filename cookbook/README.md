# Relay cookbook

Six canonical recipes show the supported Relay v1 integration patterns. Each
recipe has one outcome:

Each Chat has one human user and one or more agents. Group examples demonstrate
multi-agent Chats, not human collaboration or invitations. The agent can still
message its user; no recipe syncs a phone address book or discovers humans.

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
