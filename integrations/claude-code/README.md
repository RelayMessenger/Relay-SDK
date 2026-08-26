# Relay channel for Claude Code

Message a running Claude Code session through your Relay agent conversation.
The plugin is a self-contained MCP stdio server for Claude Code's experimental
[channels contract](https://code.claude.com/docs/en/channels-reference).

- Owner-authenticated Relay messages enter the session as
  `notifications/claude/channel` events.
- The `reply` tool sends a logical message back under a `msg_` id, so a
  retry replays that message instead of sending a second one.
- Permission prompts can be reviewed and denied from Relay. Remote Allow is
  available only when Claude supplies a complete, verifiable tool-input JSON;
  otherwise approval remains local.

## Requirements

- Node.js 20.11 or newer
- Claude Code with channel support (channels remain a research preview)
- A Relay agent and Agent Token

## Install

Install the published CLI, pair once, and install its bundled local
marketplace:

```sh
npm install -g @relaymessenger/cli
relaymessenger pair
relaymessenger install-claude
```

`pair` runs the OAuth device-authorization flow: it prints a short user code
and a verification link, you approve the device in the Relay app, and the CLI
picks up the agent's API key when you do. Nothing is pasted into the terminal
and the code expires on its own if you walk away.

`install-claude` strictly validates the bundled source, copies it to a stable
content-addressed directory under the paired account's private Relay runtime,
registers the local `relaymessenger-bundled` marketplace, and installs
`relay@relaymessenger-bundled`. It does not depend on this GitHub repository or on
the npm package remaining at its original install path. The installed plugin
already contains `runtime/server.mjs` with all runtime dependencies bundled;
do not locate a plugin cache or run `npm install` after installation.

## Configure

The install command also configures the channel without exposing the token:

```text
relaymessenger install-claude
```

That command writes the paired token, API origin, and owner pin to the
platform-equivalent of:

```text
~/.claude/channels/relay/.env
```

with owner-only permissions and these values:

```dotenv
RELAY_AGENT_TOKEN=<your agent token>
RELAY_BASE_URL=https://api.relayapp.im
# Optional explicit owner pin. Otherwise GET /v1/agents/me must return one.
#RELAY_OWNER_USER_ID=usr_...
# Optional stable session namespace. Defaults to the Claude project directory.
#RELAY_CHANNEL_SESSION_ID=my-repository
# Explicit opt-in for a private agent only: trust the first user sender.
#RELAY_ALLOW_TOFU=1
```

The file is mode 600/current-user-only. The command never prints the token and
refuses to overwrite a different existing channel identity. Run
`/relay:configure` for verification or for manual setup when relaymessenger is not
available and you already have a token through another secure route.

`RELAY_BASE_URL` must be an HTTPS origin with no path, query, fragment, or
embedded credentials. Plain HTTP is accepted only for `localhost`,
`127.0.0.1`, or `::1` development servers.

Verify without printing the token:

```text
node <installed-plugin-directory>/runtime/server.mjs --check
```

## Run

Custom channels require Claude Code's development-channel flag during the
research preview:

```text
claude --dangerously-load-development-channels plugin:relay@relaymessenger-bundled
```

Use `server:relay` instead when registered as a bare MCP server.

`GET /v1/events` is a plain pull that coexists with webhooks, and every reader
of an agent's stream receives every event. Two Claude sessions on one agent
therefore both see each message and both answer it: give each session its own
Relay agent unless you want the conversation answered twice.

## Delivery and retry contract

Channel notifications are unacknowledged at the Claude transport layer. This
plugin therefore stages each inbound event in an atomic local ledger before
notifying Claude and includes `delivery_id="evt_..."` on the channel tag.
Claude calls the `acknowledge` tool after fully handling it. Until then, the
delivery is re-notified every 30 seconds and replayed after a channel restart.
This is **at-least-once**, not exactly-once, delivery.

A crash after an external side effect but before acknowledgement can replay the
request. Before repeating a deploy, deletion, payment, shell command, or other
non-idempotent action, reconcile whether it already succeeded. The bridge
cannot make arbitrary tools exactly-once.

Outbound `reply` calls require a `send_id`. Reuse the same `send_id`,
conversation, and text for an unknown-outcome retry; use a new `send_id` for an
intentional repeat. The ledger binds a `send_id` to one payload and one `msg_`
id before the HTTP request, so a retry carries the id the first attempt used
and Relay replays the committed message rather than posting a second. Reusing
an id with different content is rejected.

## Permission safety and data boundary

Claude's channel permission notification exposes `input_preview`, documented
as JSON truncated at 200 characters. The plugin no longer truncates or folds
that field: it sends every character it receives and makes invisible controls
visible. When the value is shorter than the truncation boundary and parses as
complete JSON, the Relay card offers Allow and Deny. Otherwise it clearly says
the input may be incomplete, offers only Deny, and requires local-terminal
review to approve. This prevents a hidden destructive suffix from being
approved remotely.

Permission cards cross a data boundary: tool names, descriptions, shell
commands, local paths, and prefixes or complete contents supplied in the input
are uploaded to the configured Relay API and retained in Relay message history.
Do not enable permission relay for repositories or commands whose details must
not leave the machine. The Agent Token itself remains only in the local `.env`.

Only the agent owner's Relay user id can inject messages or verdicts. The owner
comes from `RELAY_OWNER_USER_ID` or `GET /v1/agents/me`; without one, startup
fails closed unless `RELAY_ALLOW_TOFU=1` was explicitly set. TOFU is suitable
only for an agent no one else can message.

## Durable state

State lives below `~/.claude/channels/relay/state/`, namespaced first by the
canonical API origin and Relay agent id. The account directory contains:

- `account-state.json` for the shared cursor and TOFU owner pin
- `event-ledger.json` for unacknowledged deliveries and recent event ids

Those two files are account-scoped so a later Claude session inherits the poll
position instead of replaying retained history. Each hashed session
subdirectory separately contains `routing.json` and `session-ledger.json` for
last-conversation routing, permission registrations, and logical outbound
sends. A new session cannot answer an old session's permission card.

Writes use owner-only files and atomic rename. If the cursor state or
either security-critical ledger is corrupt, startup fails closed and preserves
a block marker plus the quarantined file instead of resetting the cursor or
silently replaying old events. Session routing state may be quarantined and
reset because it does not guard event delivery or external side effects.

## Development

```text
npm ci
npm run check
npm test
npm run build
npm run pack:smoke
```

`npm run build` produces the checked-in, self-contained
`runtime/server.mjs`. `npm pack` runs that build again through `prepack`. The
root release checks also run Claude Code's pinned `plugin validate --strict`
against both the plugin and marketplace before npm publication.
