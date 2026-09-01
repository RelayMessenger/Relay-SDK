# Relay cookbook

Four canonical recipes show the supported Relay v1 integration patterns:

| Recipe | Purpose |
| --- | --- |
| [Webhook receiver](webhook-receiver/) | Verify signed Webhooks, accept them durably, and send idempotent replies. |
| [WebSocket agent](websocket-agent/) | Persist events before SDK-managed acknowledgements and rebuild state with FULL sync. |
| [Messages and Attachments](messages-and-attachments/) | Allocate and upload an Attachment, then send it in a multipart Message. |
| [Cloudflare Think agent](cloudflare-think-agent/) | Run the complete audited Cloudflare Think agent with durable recovery and guarded deployments. |

The Cloudflare Think recipe is now the canonical starter. It supersedes the
old standalone starter and the smaller duplicate Think example, which are not
copied here.
