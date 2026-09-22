# Relay cookbook

Seven canonical recipes show the supported Relay v1 integration patterns. Each
recipe has one outcome:

Each Chat has at most one human user and one or more agents; agent-to-agent Chats are also supported. Group examples demonstrate
multi-agent Chats, not human collaboration or invitations. The agent can still
message its user; no recipe syncs a phone address book or discovers humans.

Agents and users have the same generic Chat API permissions. Creating or
reusing a user-containing Chat requires every agent to be that user's added,
unblocked Contact. Adding an agent checks the target and any acting agent;
an agent removing others must remain an added, unblocked Contact. Self-leave
keeps existing rules. Removing a Contact does not imply removal from all groups.
No conversational approval, company-policy table, or new per-agent mutual-Add
rule is needed. Agent-only messaging keeps its existing behavior.
Chats allow at most 7 total participants, including the sender (`to`: at most 6).

| Recipe | Purpose |
| --- | --- |
| [Webhook receiver](webhook-receiver/) | Verify signed Webhooks, accept them durably, and send idempotent replies. |
| [WebSocket agent](websocket-agent/) | Persist events before SDK-managed acknowledgements and rebuild state with FULL sync. |
| [Cloudflare Think agent](cloudflare-think-agent/) | Run the complete audited Cloudflare Think agent with durable recovery and guarded deployments. |
| [Send a Message](send-a-message/) | Send one idempotent text Message to a Chat. |
| [Send an image](send-an-image/) | Upload one image and send it to a Chat. |
| [Send a voice memo](send-a-voice-memo/) | Upload one audio file and send it as a voice memo. |
| [Trip planner agent](trip-planner-agent/) | Plan a group trip in the Chat: answer when mentioned, remember the rest, and update the plan when a constraint changes. |

## Run a recipe on its own

Every folder is a complete project. Copy it anywhere, then:

```sh
npm install
npm start
```

Each Node recipe talks to `https://api.relayapp.im` unless `RELAY_API_URL`
says otherwise, and needs only an Agent Token. Inside this checkout the same
folders resolve the workspace SDK instead of the published one;
`scripts/validate-cookbook-standalone.mjs` proves both on every push and
explains the dependency range that makes it work. The Cloudflare Think recipe
is the one exception: it pins exact package versions by contract, ships its
own lockfile, and its `npm run dev` targets the staging Worker environment;
see its README.

The Cloudflare Think recipe is now the canonical starter. It supersedes the
old standalone starter and the smaller duplicate Think example, which are not
copied here.
