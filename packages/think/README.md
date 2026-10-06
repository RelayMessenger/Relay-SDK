# `@relaymessenger/think`

`@relaymessenger/think` is the Relay runtime for agents built on
[Cloudflare Think](https://developers.cloudflare.com/agents/). It carries what
every Relay agent does the same way: Calls, reactions, replies, location
shares, payment requests, selections, typing, generation activity, chat
timing, and the model history the agent reads back.

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
    return { ...relayActions(this.env, this), ...myOwnTools };
  }
}
```

The Actions are `send`, `react`, `request_location`, `read_location`,
`start_call`, `find_agents`, `payment_request`, `group`,
`share_contact_card` and `stay_silent`. They call Relay with
`RELAY_AGENT_TOKEN` and `RELAY_API_ORIGIN` from your Worker's `env`, and read
the Chat and Message of each turn from your agent's messenger context.

Leave Actions out by name:

```ts
relayActions(this.env, this, { disable: ["start_call", "group"] });
```

`send` offers `image` and `voice_memo` only when you give it your own models:

```ts
relayActions(this.env, this, {
  media: {
    image: async (prompt, signal) => ({ bytes, contentType: "image/png" }),
    voiceMemo: async (text, style, signal) => ({ bytes, contentType: "audio/x-wav", durationMs }),
  },
});
```

End a turn with `stopWhen: relayTurnSettled`: it ends the turn once a Relay
Action has done its one visible act, and keeps it going after a read or one of
your own tools.

The Actions come from `@relaymessenger/think/actions` because they load
`@cloudflare/think`, which runs only inside a Worker.
