# `@relaymessenger/think`

`@relaymessenger/think` is the Relay runtime for agents built on
[Cloudflare Think](https://developers.cloudflare.com/agents/). It carries what
every Relay agent does the same way: Calls, reactions, replies, location
shares, payment requests, selections, forms, rating requests, files,
contact cards, typing, generation activity, chat timing, and the model
history the agent reads back.

```sh
npm install @relaymessenger/think @cloudflare/think ai chat zod
```

`@cloudflare/think`, `ai`, `chat` and `zod` are peer dependencies, so the
agent keeps one copy of each.

## Create the Relay client

```ts
import { createRelayClient, startRelayTypingLifecycle } from "@relaymessenger/think";

const relay = createRelayClient(env); // reads env.RELAY_AGENT_TOKEN and env.RELAY_API_ORIGIN
```

## Load every Relay tool in one call

`relayActions` returns every Relay Action, in the shape Think's
`getActions()` takes. Spread your own tools beside them.

```ts
import { Think } from "@cloudflare/think";
import { relayActions } from "@relaymessenger/think/actions";

export class MyAgent extends Think<Env> {
  override getActions() {
    return { ...relayActions(this, { env: this.env, ctx: this.ctx }), ...myOwnTools };
  }
}
```

The Actions are `send`, `react`, `request_location`, `read_location`,
`start_call`, `find_agents`, `payment_request`, `group`,
`share_contact_card` and `stay_silent`. They call Relay with
`RELAY_AGENT_TOKEN` and `RELAY_API_ORIGIN` from `env`. A voice memo's send
finishes after its Action returns, so it goes to `ctx.waitUntil`.

Options:

- `disable: ["start_call", "group"]` leaves Actions out by name.
- `media: { image, voiceMemo }` gives `send` your own image and speech
  models; without them `send` offers no `image` or `voice_memo` kind.
- `describe: (name, description) => string` changes an Action's description,
  for example to tell `start_call` your own follow-up tool can call later.
- `webSearch: true` removes Google Search citation markers (`[1.2]`) from
  the words `send` sends, for a model that searches.

### What `send` sends

`send` takes one `kind`:

| Kind | What the person gets |
| --- | --- |
| `text` | Words, with optional buttons or a selection |
| `link` | A page drawn as a card |
| `place` | A pin on a map |
| `media` | A file from a public `https` URL; Relay downloads it |
| `image` | A picture from your image model (`media.image`) |
| `voice_memo` | A voice memo from your speech model (`media.voiceMemo`) |
| `payment` | A payment card with a Pay button |
| `rich_card`, `carousel` | One card, or 2 to 10 side by side |
| `form` | A form of one or more pages of fields |
| `rating_request` | A request to rate your agent, as the whole Message |

The SDK's own validators check selections and forms before anything is sent.

### Turns that answer no Message

By default each Action reads the turn's Chat and Message from Think's
messenger context. A turn your agent starts on an event (an unanswered Call,
a schedule) has none, and the Actions throw `RelayTurnRequired`. For such
turns, pass `turn`:

```ts
relayActions(this, {
  env: this.env,
  ctx: this.ctx,
  turn: () => this.currentEventTurn ?? relayTurnFromMessenger(this.getMessengerContext()),
});
```

Return `{ chatId, eventId }` with no `replyTo`: then a quote-reply is
refused (`RelayReplyRefused`) and the model sends without one.

### End the turn

The model decides how many Messages a turn sends: one, or several in a row,
like a person texting. Each `send` call is its own Message, keyed by its
place in the turn: the first send is `message:<eventId>:1`, the next `:2`.
When Think runs the turn again after a restart, the count starts again at 1,
so a send that already went is not sent twice. Each Message gets its own
composing pause.

Only `send` makes Messages. Think posts the model's plain reply text to the
chat unless the messenger's delivery policy stops it, so give Relay's
messenger `RELAY_MESSENGER_DELIVERY`:

```ts
import { RELAY_MESSENGER_DELIVERY } from "@relaymessenger/think";

chatSdkMessenger({ adapter, provider: "relay", delivery: RELAY_MESSENGER_DELIVERY, /* ... */ });
```

Give Think `stopWhen: relayTurnSettled`. The turn ends when the model calls no
tool, calls `stay_silent`, or starts a call that rings; after a send, a
reaction or a read the model goes on. Cap a runaway turn with
`stepCountIs(RELAY_TURN_MAX_STEPS)`. To end the turn after one of your own
tools, name it:

```ts
stopWhen: [createRelayTurnSettled({ visibleSends: ["hand_to_person"] }), stepCountIs(RELAY_TURN_MAX_STEPS)],
```

### Compose your own

`createRelayActions(deps)` is the factory under `relayActions`, with every
hook given by hand, for an agent that keeps its own turn bookkeeping.

The Actions come from `@relaymessenger/think/actions` because they load
`@cloudflare/think`, which runs only inside a Worker.

## Read what people send back

Some of what a person sends is not in a Message's text: the values they
chose, a form's answers, a card someone shared. Wrap the Relay adapter so
each one reaches the model as a data line beside the words:

```ts
import { createRelayAdapter } from "@relaymessenger/chat-sdk-adapter";
import { withCardReplies, withContactCards, withFormReplies, withSelectionReplies } from "@relaymessenger/think";

const adapter = withContactCards(withFormReplies(withCardReplies(withSelectionReplies(createRelayAdapter(config)))));
```

- `withSelectionReplies` adds the values of a selection answer.
- `withCardReplies` adds the id of a card suggestion the person tapped.
- `withFormReplies` adds a form's answers, keyed by field id, and the form
  they answer.
- `withContactCards` adds a shared contact card: who shared it, and the
  card's kind, id, handle and name.
