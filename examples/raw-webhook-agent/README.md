# raw-webhook-agent

Minimal webhook agent that mirrors the Relay quickstart
(https://docs.relayapp.im/quickstart): a plain `node:http` server plus
`@relaymessenger/sdk` for signature verification, dedupe, and sending.

```bash
RELAY_AGENT_TOKEN=... RELAY_WEBHOOK_SECRET=... npm start
```

The server listens on `PORT` (default 8787) and echoes every incoming
message back to its conversation.

## Delivery contract

Relay delivers events at least once and retries only on 408/429/5xx, so the
handler acknowledges last:

1. Verify the Standard Webhooks signature over the exact raw body (401 on
   failure).
2. Skip `event_id`s already in the dedupe window (200, already answered).
3. Do the work: mark responding, send the reply with an idempotency key
   derived from `event_id`.
4. Record the `event_id` in the dedupe window only after the reply
   succeeded, then return 200.
5. On handler failure return 500 so Relay redelivers; the event_id was not
   recorded, so the retry is handled again.

Acknowledging before the work is done would lose the event if the process
crashed after the ack. The event_id-derived idempotency key makes the
redelivery path safe: a retried event replays the same send instead of
double-posting.
