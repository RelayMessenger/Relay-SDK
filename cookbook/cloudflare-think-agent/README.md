# Relay Agent Starter

Minimal, forkable [Cloudflare Think](https://developers.cloudflare.com/agents/harnesses/think/)
agent for [Relay Messenger](https://relayapp.im).

It uses:

- `@cloudflare/think@0.17.0` and native durable recovery;
- `chatSdkMessenger()` with Relay's official Chat SDK adapter;
- one root Think conversation per Relay Chat;
- signed Standard Webhooks ingress at `POST /webhooks/relay`;
- direct-message replies and canonical structured mentions in groups;
- one buffered, idempotent Relay Message per model turn;
- payments: the model asks the person to pay, the Worker creates the request.

There are no application-owned event or send tables, polling loops, outbound
WebSockets, partial Message bubbles, Message effects, or copied Relay client.
Think owns conversation memory, fibers, recovery, and its Action ledger. The
Relay packages own webhook verification and API calls.

## How a Message moves

1. Relay sends a signed `message.received` webhook.
2. `@relaymessenger/chat-sdk-adapter` verifies the exact raw body before parsing.
3. The Worker hands the delivery to the Chat's durable root Think conversation
   and answers `202 Accepted` immediately, without waiting for the turn.
   Thinking outlives any webhook timeout, so holding the response open would
   make Relay redeliver the same event and buy a second turn saying the same
   thing.
4. Inside the Durable Object the adapter verifies the forwarded raw body again
   and marks the Chat read, before Chat SDK dispatch. The read states that the
   message arrived, so no debounce window and no model turn can delay it.
5. Direct Messages start turns. Group Messages start turns only when a text
   part's structured `mention` matches the receiving Chat's `owner_handle`.
   Every inbound Message is read, whether or not it starts a turn: at receipt
   the adapter has not run mention detection yet, and a read in a group is
   invisible anyway, because Relay renders only Delivered there and never a
   member's Read.
6. Think runs the model in a recoverable fiber. The model must call the native
   `reply` Action once.
7. The Action commits one complete Message through the same adapter, so the
   Worker holds one Relay client. Its idempotency key is the adapter's own
   `relay-chat-sdk:<event_id>:<ordinal>`, derived from the event that caused
   the send.

## Payments

The `reply` Action takes an optional `payment`: the fields of
`POST /v1/payment_requests` a model can know (`description`, `category`,
`amount` and `currency`, or `mode: "subscription"` with `price_id` and an
optional `quantity`, and an optional `image_url`). The system prompt carries
the SDK's `PAYMENT_GUIDANCE`, the same words every other Relay runtime uses.

The Worker checks the fields with the SDK's `paymentRequestFields`, then
creates the request with the adapter's `createPaymentRequest` before anything
is sent. Its `Idempotency-Key` is
`relay-agent-starter:<message_id>:payment:<sha256 of the fields>`, so a retry of
the same answer returns the same request. The words go out as one Message, then
the card as its own Message carrying only `{ type: "payment", checkout_url }`.

When Relay does not create the request (403 until Stripe is connected in Relay
Console, Stripe's own 400, or a temporary failure), nothing is sent: the error
is the Action's result, and the turn allows the model one more step to call
`reply` again, with the payment fixed or without it. Every other turn ends
after its one `reply`.

The money settles to your own connected Stripe account; Relay takes a 5% fee
on every payment as a Stripe application fee, shown as
`application_fee_amount` on the payment request. A paid request arrives as a
`payment_receipt` Message, which the adapter reads as one line of text.

## Known limits in Think 0.17.0

Two behaviours a Relay agent wants are not expressible through
`@cloudflare/think` 0.17.0. Both were read from the shipped bundle. Raise them
upstream rather than working around them here.

**The burst window is fixed at 600 ms.** A burst of Messages does produce one
answer: `chatSdkMessenger` is a pure spread (`dist/chat-sdk-C8BvREXn.js:354-359`)
and Think builds the Chat SDK instance itself with
`concurrency: { debounceMs: 600, strategy: "burst" }` hardcoded
(`dist/chat-sdk-C8BvREXn.js:421-424`). The strategy is the one we want, but no
option reaches the window, so Messages collapse on Think's 600 ms rather than a
window this Worker chooses. That one answer is for the latest Message only: the
Chat SDK dispatches the latest Message and passes the earlier ones as
`context.skipped` (`chat` 4.39.0, `dist/index.js:2436-2454`), and Think's
`(thread, message)` handlers never read that argument, so the earlier Messages
in the window never reach the model.

**A newer Message cannot cancel the running turn.** Think's messenger handlers
take only `(thread, message)` and never the Chat SDK's third `context` argument
(`dist/chat-sdk-C8BvREXn.js:433-459`); `signal` and `abort` appear nowhere in
that bridge. So `ChatInstance.abortTurn(threadId)` fires a signal Think never
reads, and the superseded turn finishes and posts its answer anyway. Think's own
`cancelAllChats()` does stop the running turn, but it also leaves the newer
Message unanswered, so it is not used. The adapter's
`abortActiveTurnOnReceipt` is therefore deliberately left off here; it is
correct for Chat SDK consumers whose handlers do read `thread.signal`
(`chat` 4.39.0, `dist/types-Bv-_sd-h.d.ts:418`).

Think's streamed response surface is intentionally limited to zero visible
characters. Relay therefore never receives a draft or a second fallback
Message; only the complete Action payload is committed.

If an isolate dies after Relay commits the Message but before Think settles the
Action ledger row, Think can reclaim that pending Action immediately. The retry
uses the same Relay idempotency key and body, so Relay replays the existing
Message instead of creating a duplicate.

## Prerequisites

- Node.js 22.22.3 or newer
- a Cloudflare account with Workers AI
- an agent and its Agent Token from [Relay Console](https://console.relayapp.im)

The starter pins `@relaymessenger/chat-sdk-adapter@0.3.13` and
`@relaymessenger/sdk@0.5.3` from npm.

## Local setup

Install the exact registry artifacts from `package-lock.json`:

```sh
npm ci
```

Copy the local secret template:

```sh
cp .dev.vars.example .dev.vars
```

Set both values in `.dev.vars`:

```dotenv
RELAY_AGENT_TOKEN=replace-with-agent-token
RELAY_WEBHOOK_SECRET=whsec_replace-with-webhook-secret
```

The non-secret settings are in `wrangler.jsonc`:

```text
RELAY_API_ORIGIN=https://api.relayapp.im
RELAY_AGENT_HANDLE=your_agent_handle
MODEL_ID=@cf/openai/gpt-oss-120b
```

Change `RELAY_AGENT_HANDLE` to the agent's Relay Handle. Start the Worker:

```sh
npm run dev
```

For a public local webhook URL, use your normal HTTPS tunnel and register its
exact `/webhooks/relay` path.

## Replace the model

[`src/model.ts`](src/model.ts) is the model seam:

```ts
export function starterModel(env) {
  return env.MODEL_ID;
}
```

Return another Workers AI model ID, or replace the function with any AI SDK
`LanguageModel`. Relay ingress, group routing, recovery, and canonical delivery
do not need to change.

Change the short system prompt in [`src/agent.ts`](src/agent.ts) for product
behavior. Keep the instruction to call `reply` once unless you also replace the
delivery design.

## Validate

```sh
npm run types:check
npm run check
npm run test:unit
npm run test:workerd
npm run test:installed
npm run dry-run
```

The suites cover the contract lock, dependency pins, deployment isolation and
non-inherited Wrangler bindings, migration operation, model seam, signed direct
and mentioned-group model/Action turns, unmentioned-group gating, stale Action
recovery without duplicate delivery, and a clean registry-installed template.

## Deploy

Store the Agent Token and webhook signing secret as Worker secrets, then deploy:

```sh
npx wrangler secret put RELAY_AGENT_TOKEN
npx wrangler secret put RELAY_WEBHOOK_SECRET
npx wrangler deploy
```

Create a webhook subscription for the deployed Worker's `/webhooks/relay` URL.
The deployed Worker uses the settings in `wrangler.jsonc`, which name
`https://api.relayapp.im`.

## Contract lock

This revision is tested against:

- Relay Server `8247505bd5f8dffccf8047b91317a68a91632068`
- Relay-SDK `ea4a4bc1792f7260f98184f6bd9bcdea7746aa1e`
- `@relaymessenger/chat-sdk-adapter@0.3.13` npm integrity
  `sha512-fCstCmGGZ15VZtZWpfrXc7nN+KGRVAYlBVY9NF4w806Zxssgbm7v1LYl3542hTeg7mnt8PkRzTVZGq5XMTTABA==`
- `@relaymessenger/sdk@0.5.3` npm integrity
  `sha512-3du5+8VQlwV5lMgdlQ3pINIo2g+mM+rcjG7B1jxQOaORvBl78kM0jTpfF1xODP4qhNyq9RLZ0ClxM3f01r81SA==`
- OpenAPI SHA-256
  `f1d3f19b12e068ad68b95b41650b62af6f921ec263e37dd2d24f59a72903ce30`
- public `ChatHandle.image_url` and `ChatHandle.about` fields, with no legacy
  aliases
- Relay API `v1`
- Relay webhook payload version `2026-08-30`

The byte-identical Server OpenAPI fixture is under
[`contracts/`](contracts/).

## Documentation

- [Relay developer docs](https://docs.relayapp.im)
- [Relay + Cloudflare integration](https://docs.relayapp.im/integrations/cloudflare)
- [Relay webhook guide](https://docs.relayapp.im/guides/webhooks)
- [Cloudflare Think](https://developers.cloudflare.com/agents/harnesses/think/)
- [Think Messengers](https://developers.cloudflare.com/agents/harnesses/think/messengers/)
- [Think durable recovery](https://developers.cloudflare.com/agents/harnesses/think/recovery/)
- [Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
