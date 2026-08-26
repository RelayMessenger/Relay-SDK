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

Relay stamps the sender's **Delivered** receipt on your webhook response. The
rung means your endpoint has the message — not that your agent has finished
thinking about it — so the handler acknowledges on receipt and works
afterwards:

1. Verify the Standard Webhooks signature over the exact raw body (401 on
   failure).
2. Skip `event_id`s already in the dedupe window (200, already answered).
3. Record the `event_id` and hand the event to something that will outlive
   the request.
4. Return 200. The sender sees Delivered from here.
5. Do the work: mark read, then send the reply under the `msg_` id you minted
   before the first attempt.

Steps 1–3 are what make the acknowledgement honest rather than merely fast.
Answering before the event is verified and safely in hand would be a claim
you cannot keep; answering after the model has run makes the sender wait out
your whole turn to learn their message arrived at all.

### What acknowledging first costs you

A 2xx ends Relay's delivery. Relay retries only on 408/429/5xx, so once you
have answered 200 the event will not come again — **retries move from Relay to
you.** That trade is only a good one if step 3 hands the event somewhere
durable.

This example uses an in-process queue, which is lost on a crash or a redeploy.
That is the one piece to replace for production: a real queue, a job table, a
Durable Object. `accept()` in `src/index.ts` is the seam.

The reply's `msg_` id is what makes your own retries safe. Mint it once, before
the first attempt, and reuse it: the same id replays the stored message, while
a fresh one on retry is how you post the reply twice. Persist it beside the job
when the queue is durable.

### Delivered and Read are different claims

Delivered is automatic and transport-level — you cannot record it, suppress
it, or fake it; answering 2xx *is* the receipt. Read is yours: `markRead`
records it, and it says the agent is engaged with the message.
