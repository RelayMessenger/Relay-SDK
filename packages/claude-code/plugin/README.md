# Relay channel for Claude Code

[Relay Messenger](https://relayapp.im) as a two-way channel for a running
Claude Code session. The complete source for the `relay-claude-channel` npm
package and the `relay` Claude plugin is maintained in
[`RelayMessenger/Relay-SDK`](https://github.com/RelayMessenger/Relay-SDK/tree/main/packages/claude-code)
under `packages/claude-code`.

The channel is rebuilt for Relay v1. It uses
`@relaymessenger/sdk@0.3.0-staging.7` and one acknowledged outbound connection
to `/v1/websocket`; it does not use the removed Events polling, Conversation,
or private Agent identity APIs.

## Requirements

- Node.js 22.22.3 or newer
- Claude Code with Channels research-preview support
- A Relay Agent Token
- At least one exact Relay user UUID or Handle to allowlist
- No saved Webhook subscription for that Agent

A Relay Agent has one delivery mode. This process refuses to connect while any
saved Webhook subscription exists; it never deletes subscriptions for you.

## Install as a Claude plugin

This package directory contains its own marketplace. Clone the public
Relay-SDK monorepo:

```bash
git clone https://github.com/RelayMessenger/Relay-SDK
```

Then add the exact package directory inside Claude Code:

```text
/plugin marketplace add /absolute/path/to/Relay-SDK/packages/claude-code
/plugin install relay@relay-messenger
```

The plugin is disabled by default because it connects to an external messaging
service. Enable it in `/plugin`. Claude Code prompts for:

- **Relay Agent Token**: sensitive; Claude Code stores it in secure credential
  storage rather than `settings.json`.
- **Allowed Relay senders**: comma-separated exact user UUIDs or Handles.
- **Relay API origin**: keep `https://api.relayapp.im` unless the token belongs
  to a trusted non-production Relay environment.

Relay is not on Anthropic's default channel allowlist. During the research
preview, start a custom installation with:

```bash
claude --dangerously-load-development-channels plugin:relay@relay-messenger
```

An organization administrator can instead add `relay@relay-messenger` to
`allowedChannelPlugins`, after which users opt it in with `--channels`.
Channels must also be enabled for managed organizations.

### Manual environment fallback

The runtime also reads `~/.claude/channels/relay/.env` (or the equivalent under
`CLAUDE_CONFIG_DIR`) when plugin user configuration is unavailable:

```dotenv
RELAY_AGENT_TOKEN=<Agent Token>
RELAY_ALLOWED_SENDERS=<user UUID or exact Handle>[,<another sender>]
RELAY_BASE_URL=https://api.relayapp.im
# Optional stable namespace used by the outbound send ledger.
# RELAY_CHANNEL_SESSION_ID=my-project
```

Create the directory as owner-only and the file as mode `600`. Never paste the
token into a Claude conversation or put it in a command argument. Verify from
the installed plugin directory without printing credentials:

```bash
node runtime/server.mjs --check
```

## Delivery contract

Relay WebSocket delivery and Claude channel delivery have different
acknowledgements:

1. The SDK receives a sequenced Relay event.
2. The channel atomically inserts the full event and advances its local cursor
   in a SQLite transaction with `synchronous=FULL`.
3. Only after that commit resolves does the SDK send Relay's cumulative
   WebSocket ACK.
4. A separate worker authenticates the Message sender and stages a Claude
   channel notification. Direct Messages are eligible. Group Messages are
   eligible only when their structured `parts[].mention` matches this Agent's
   canonical Handle or they reply to a Message authenticated as sent by this
   Agent.
5. Claude Code does not acknowledge channel notifications. The plugin therefore
   re-notifies a staged delivery until Claude calls `begin_processing`.
6. `begin_processing` records the start attempt, calls Relay's explicit
   `chats.markAsRead`, and stops replay only after that REST call succeeds.

Transport ACK does **not** mark a Message Read. Read happens at actual processing
start, not receipt, durable staging, or notification write.

Delivery into Claude is at least once. A process crash can replay a notification
or a `begin_processing` attempt. Before repeating a deploy, payment, deletion,
or other non-idempotent side effect, reconcile whether it already succeeded.

### FULL sync

When Relay says the saved WebSocket checkpoint is outside retention, the SDK
calls `onFullSync`. The plugin pages through every public Chat and every visible
Message, verifies Chat/Message identity, builds a complete snapshot, reconciles
all unread, addressed, allowlisted inbound Messages, and atomically commits the
snapshot and `throughSequence`. It determines this Agent's Read state only from
the single `deliveries[]` row whose `contact.is_me` is true; aggregate
top-level `read_at` is never used for this decision. The SDK sends
`full_sync_complete` only after that commit.

The channel fails closed instead of completing FULL sync when it cannot
authenticate an unread Message, sees duplicate or cross-Chat Message identity,
would move the checkpoint backward, or exceeds its safe unread backlog limit.
It never resets a corrupt database or silently skips an incomplete snapshot.

## Tools

### `begin_processing`

Required first call for every Relay channel event. Takes `delivery_id` from the
`<channel>` tag and marks that Chat Read through the public Relay API. Do not
process the content if the tool returns an error. Success opens one turn-scoped
reply origin with a ten-minute maximum lease. Starting another turn closes
the previous one as superseded; a closed or expired delivery cannot be
reactivated.

### `complete_processing`

Closes the active turn without sending a Relay Message. Pass the same
`delivery_id` and `outcome` of `completed` or `failed`. Use it whenever a turn
finishes without `reply` or must be abandoned. Shutdown and process restart
also fail and clear any surviving active turn.

### `reply`

Sends plain text through `chats.messages.send` with:

- `chat_id` copied from an allowlisted channel event;
- `text` of at most 10,000 UTF-16 code units;
- a caller-selected stable `send_id`; and
- optional `reply_to_message_id`.

The mapping from `send_id` to request hash and Relay idempotency key is persisted
before the REST request. An unknown-outcome retry must reuse the same arguments
and `send_id`; changed content is refused. A deliberate second Message uses a
new `send_id`. The tool refuses a Chat other than the authenticated origin of
the active turn, and any `reply_to_message_id` must be that turn's Message. A
confirmed send completes and clears the turn automatically. A byte-identical
retry of an already-confirmed `send_id` remains an idempotent success without
reopening its turn.

The plugin exposes no Message effects, reactions, edits, installation APIs, or
private Relay endpoints.

## Sender and Claude permission safety

Only configured Relay user UUIDs or exact Handles can inject content. Sender
authentication runs before content interpretation.

Claude Code permission prompts and approval decisions are **local only**. The
plugin does not advertise the Claude permission channel capability, does not
handle permission-request notifications, never sends permission cards to Relay,
and never interprets Relay Messages as approval verdicts. Review and answer
every tool permission in the local Claude Code interface.

Relay Agent Tokens and recognizable Relay token strings are redacted from
channel content, replies, logs, and tool errors.

## Durable state

State is account-scoped below `~/.claude/channels/relay/state/` and includes:

- the local accepted-through cursor and event identity hashes;
- pending channel deliveries and explicit Read-start status;
- one short-lived, per-session delivery-turn lease used for reply and
  Chat isolation, plus closed-turn markers that prevent reactivation;
- the complete last FULL-sync snapshot;
- observed reply destinations;
- logical outbound sends.

Before opening the original database, preflight reads the database, WAL, and
shared-memory bytes twice. Only when all filenames and SHA-256 hashes are stable
does it write those captured bytes into a private temporary directory and open
that copy read-only. The copied WAL therefore makes committed but uncheckpointed
schema metadata authoritative, while SQLite may safely update only the copied
shared-memory file. A future schema refuses startup with the original database,
WAL, and shared-memory files byte-identical.

The account directory is derived from the API origin and a one-way Agent Token
fingerprint; the token itself is never written. Rotating an Agent Token changes
that fingerprint. Preserve a reviewed state directory or force a server FULL
sync before using a new token against an Agent whose server checkpoint is
already ahead; a local cursor gap fails closed.

Only one local process may hold an account's consumer lock. Relay also fences
stale WebSocket connections server-side.

## Contract lock

`contracts/relay-v1.lock.json` pins:

- Relay Server commit `ddcbccb44b9f85e8c2e3e63fead9b81d52f2bd15`;
- OpenAPI SHA-256
  `26a6bc047286e09df6ef95f3c6b09f0437260ecc94e12c5fb3ce1704910f8ba1`,
  with public `ChatHandle.image_url` and `ChatHandle.about` fields and no legacy
  aliases;
- `@relaymessenger/sdk@0.3.0-staging.7`; and
- the official Claude Code documentation and validation baseline used on
  2026-09-01.

To verify a checked-out OpenAPI file as well as source guards:

```bash
npm run contract:check -- --openapi /path/to/contracts/developer/openapi.yaml
```

## Development

```bash
npm ci
npm run check
npm test
npm run contract:check -- --openapi /path/to/openapi.yaml
npm run build
npm run pack:smoke
npm run claude:validate
```

`prepack` runs type checks, all tests, contract checks, the build, and generated
artifact identity/hash checks. `npm run release:validate` then builds an npm
tarball, installs it in an empty project with only production dependencies,
rejects development/secret files, verifies package/plugin/runtime hashes and
the installed Relay SDK, and runs all strict Claude marketplace/plugin/command
validators. npm publication is staging-only with provenance; the manual
workflow additionally requires an exact lowercase staging-branch SHA and exact
staging prerelease version.

## License

MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
