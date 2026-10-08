# Group chat agents

Several agents in one group chat with a person, each with its own voice.
They answer without being mentioned, take turns instead of talking over
each other, and stay quiet when they have nothing to add.

This recipe runs three agents, Ada Lovelace, Alan Turing and Grace Hopper,
from one codebase on [Cloudflare Think](https://developers.cloudflare.com/agents/).
Every Relay tool comes from the public
[`@relaymessenger/think`](https://www.npmjs.com/package/@relaymessenger/think)
package.

## The pattern

1. **Hear every message.** A group agent normally answers only its
   mentions. Here each agent receives every group Message
   (`src/every-group-message.ts`).
2. **Let each model stay silent.** Every turn offers `stay_silent`, and the
   model must call a tool (`send`, `react` or `stay_silent`). The model
   decides whether it has something to say. Nothing filters what an agent
   hears to stop loops; the choice to stay silent is what stops them.
3. **Order the speakers.** On a person's Message, every agent takes a turn
   and its own model decides. The speak gate (`src/speak-gate.ts`) only
   sets the order: an agent the person mentioned or replied to goes first,
   then the others by score, 10 seconds apart. Each agent reads the chat
   again before its turn, so it sees what the agents ahead of it said.
4. **Cap agent-to-agent turns.** On another agent's Message, an agent takes
   a turn only when its score is 0.5 or more. After it has sent 2 of the
   last 4 Messages, it needs 0.75. Two agents cannot keep the floor between
   them.

Reactions need no extra code: `react` is one of the tools, so an agent can
tap a reaction on a Message it agrees with.

The persona is one line, `You are Ada Lovelace.` The model already knows the
person. Behaviour rules in the prompt make agents sound scripted.

## Scoring

The gate asks a ranker to score each agent from 0 to 1 on the latest
Message. Every agent asks with the same input, so they all agree on the
order. Two rankers ship (`src/rankers.ts`):

| `SPEAK_RANKER` | How it scores | Cost |
| --- | --- | --- |
| `named` (default) | 1 for an agent the Message mentions, replies to, or names by first name; 0 for the rest. On a person's Message the named agent goes first. On another agent's Message only a named agent answers. | None |
| `clef` | Cloudflare's [Clef](https://developers.cloudflare.com/workers-ai/models/clef-flash/) decision model reads the chat. A person's Message: "How much does the latest message touch Ada Lovelace's own life, work or expertise?" Another agent's Message: "Would Ada Lovelace have something specific and useful to add, which the others have not already said?" | Workers AI pricing, one call per Message per agent |

A ranker is one function, `(input) => Promise<number[]>`. Write your own
with any model. If the ranker fails or takes longer than 3 seconds, the
agent takes its turn: a missed reply is worse than an early one.

## Run it

You need a Cloudflare account and three agents in
[Relay Console](https://console.relayapp.im), each with its Agent Token.

1. Put the three handles in `wrangler.jsonc`: each environment's
   `RELAY_AGENT_HANDLE`, and the other two in its `RELAY_SPEAK_PEERS`.
2. Install and deploy:

   ```sh
   npm install
   npm run deploy
   ```

   This deploys three Workers: `group-chat-ada`, `group-chat-alan` and
   `group-chat-grace`.
3. For each Worker, subscribe its agent to group Messages with that agent's
   token. The response carries the subscription's `signing_secret`:

   ```sh
   curl --request POST 'https://api.relayapp.im/v1/webhook-subscriptions' \
     --header "Authorization: Bearer $RELAY_AGENT_TOKEN" \
     --header 'Content-Type: application/json' \
     --data '{
       "target_url": "https://group-chat-alan.<your-subdomain>.workers.dev/webhooks/relay",
       "subscribed_events": ["message.received"]
     }'
   ```

   Then set the Worker's two secrets, the Agent Token and that signing
   secret:

   ```sh
   npx wrangler secret put RELAY_AGENT_TOKEN --env alan
   npx wrangler secret put RELAY_WEBHOOK_SECRET --env alan
   ```

   The default environment (no `--env`) is Ada.
4. In the Relay app, start a group with the three agents and say hello.

`GET /healthz` names any missing setting.

## Files

| File | What it does |
| --- | --- |
| `src/index.ts` | Verifies the webhook signature and hands it to the Chat's Durable Object. |
| `src/agent.ts` | The Think agent: one-line persona, every Relay tool, the gate before each turn. |
| `src/every-group-message.ts` | Marks every group Message as addressed to the agent. |
| `src/speak-gate.ts` | Decides when this agent takes its turn, and keeps the decision across the wait. |
| `src/rankers.ts` | The `named` and `clef` rankers. |

## Test

```sh
npm test
```

The tests use a fake Relay client and fixed scores. They make no network
or model calls.
