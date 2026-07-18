# Relay channel for Claude Code

Message a running Claude Code session through your Relay agent conversation.
The plugin is a self-contained MCP stdio server for Claude Code's experimental
[channels contract](https://code.claude.com/docs/en/channels-reference).

- Owner-authenticated Relay messages enter the session as
  `notifications/claude/channel` events.
- The `reply` tool sends a logical message back with retry-safe idempotency.
- Permission prompts can be reviewed and denied from Relay. Remote Allow is
  available only when Claude supplies a complete, verifiable tool-input JSON;
  otherwise approval remains local.

## Requirements

- Node.js 20.11 or newer
- Claude Code with channel support (channels remain a research preview)
- A Relay agent and Agent Token
- No webhook enabled for that agent: Relay permits one event consumer, so
  long-polling and webhook delivery are mutually exclusive

## Install

From a marketplace containing this plugin:

```text
/plugin install relay@<marketplace>
```

The installed plugin already contains `runtime/server.mjs` with all runtime
dependencies bundled. Do not locate a plugin cache or run `npm install` after
installation.

## Configure

Run `/relay:configure`, or create the platform-equivalent of:

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

`RELAY_BASE_URL` must be an HTTPS origin with no path, query, fragment, or
embedded credentials. Plain HTTP is accepted only for `localhost`,
`127.0.0.1`, or `::1` development servers. Use
`https://api.staging.relayapp.im` for staging; a production token is not
automatically valid or safe to use there.

Verify without printing the token:

```text
node <installed-plugin-directory>/runtime/server.mjs --check
```

## Run

Custom channels require Claude Code's development-channel flag during the
research preview:

```text
claude --dangerously-load-development-channels plugin:relay@<marketplace>
```

Use `server:relay` instead when registered as a bare MCP server.

Only one live Claude session may consume an agent's event stream. A second
session fails closed instead of stealing the long-poll consumer. Use a
different Relay agent when two sessions must receive messages concurrently.

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
intentional repeat. The mapping is persisted before the HTTP request, and
reusing an id with different content is rejected.

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

- `consumer-state.json` for the shared cursor and TOFU owner pin
- `consumer-ledger.json` for unacknowledged deliveries and recent event ids

Those two files are account-scoped so a later Claude session inherits the
consumer position instead of replaying retained history. Each hashed session
subdirectory separately contains `routing.json` and `session-ledger.json` for
last-conversation routing, permission registrations, and logical outbound
sends. A new session cannot answer an old session's permission card.

Writes use owner-only files and atomic rename. If consumer state is corrupt, it
is quarantined and the independent consumer ledger still contains replay
guards. If either security-critical ledger is corrupt, startup fails closed and
preserves a block marker plus the quarantined file instead of silently
replaying old events.

## Development

```text
npm ci
npm run check
npm test
npm run build
```

`npm run build` produces the checked-in, self-contained
`runtime/server.mjs`. `npm pack` runs that build again through `prepack`.
