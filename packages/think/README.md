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
