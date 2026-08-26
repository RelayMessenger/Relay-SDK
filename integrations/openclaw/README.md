# Relay channel plugin for OpenClaw

Backs a Relay contact with an OpenClaw agent: install the plugin, point it at
an owner-only Agent Token file, and your OpenClaw appears in Relay as a contact
you text like a friend.

Requires `openclaw >= 2026.7.1-2`, which the stable channel satisfies today.

## Install

```sh
npm install -g @relaymessenger/cli
relaymessenger pair
relaymessenger install-openclaw
```

The installer uses the OpenClaw archive bundled in the installed `relaymessenger`
package, persists that archive in the paired account's private Relay runtime,
and invokes OpenClaw's managed `npm-pack:` installer on the stable copy so
declared runtime dependencies are installed with the plugin. It surgically
adds Relay to `~/.openclaw/openclaw.json`, preserves unrelated configuration,
writes the token to an owner-only file, and never prints it. It refuses to
replace a different configured Relay identity.

For integration development from this checkout only:

```sh
cd integrations/openclaw
npm install
npm pack
openclaw plugins install npm-pack:./relaymessenger-openclaw-plugin-0.1.0.tgz --force
```

The installer produces the equivalent Relay-specific configuration:

```json
{
  "plugins": {
    "allow": ["relay"],
    "entries": { "relay": { "enabled": true } }
  },
  "channels": {
    "relay": {
      "enabled": true,
      "tokenFile": "~/.openclaw/secrets/relay-agent-token",
      "baseUrl": "https://api.relayapp.im"
    }
  }
}
```

`RELAY_AGENT_TOKEN` / `RELAY_BASE_URL` are honored for the default account
when the config fields are absent. Multiple agents run as named accounts under
`channels.relay.accounts.<id>`, one token each.

## Sender security

Relay agents can be discoverable, so adding an agent as a contact is not an
authorization boundary. The plugin accepts inbound turns only from the
authenticated agent's `owner_user_id` returned by `GET /v1/agents/me` and any
Relay user ids the operator explicitly adds to `allowFrom`. Wildcards are
ignored. If neither an API owner nor an explicit allowlist is available, the
account fails closed and does not start polling.

## One process per agent

`GET /v1/events` is a plain pull. Relay serves every poller and coexists with
webhooks, so nothing on the server stops two copies of one agent from reading
the same event — and both would answer it. The plugin holds a local lock so
they cannot: see the filesystem lock under [delivery and crash
semantics](#delivery-and-crash-semantics).

## Config reference (per account)

| Field | Meaning |
| --- | --- |
| `token` / `tokenFile` | Agent Token (or file containing it) |
| `baseUrl` | Relay API origin (default `https://api.relayapp.im`). Remote origins must use HTTPS; HTTP is accepted only for loopback development. Paths, credentials, queries, and fragments are rejected. |
| `allowFrom` | Additional Relay user ids (`usr_…`) allowed alongside the API-pinned owner. These identities may also run control commands. Wildcards are ignored. |
| `pollTimeoutSeconds` | Long-poll hold time, 1–30 (default 30) |

## Harness

Run `npm run gateway:harness` from the repository root for the clean installed-
runtime proof. It packs the plugin, installs it into an isolated `HOME`, starts
a real OpenClaw gateway against `harness/mock-relay-server.mjs`, receives a
Relay event, completes a mock model turn, and verifies the reply reaches
Relay. The release workflow requires this proof.

## Delivery and crash semantics

- Every outbound send mints a `msg_` id before it leaves, and that id is the
  message's identity: Relay replays a repeat of the same id rather than
  committing a second message, so the plugin's own retries cannot duplicate a
  visible reply. Two intentional identical sends mint two ids and stay two
  messages.
- Admission, route/session resolution, envelope building, and context
  finalization run before an inbound event is marked attempted. Failures in
  that replay-safe preflight release the claim and retry the event. The marker
  is committed durably immediately before OpenClaw can dispatch the agent or
  its tools; a failure after that boundary does not silently replay possible
  tool side effects. The user can resend the message deliberately.
- The long-poll cursor and inbound attempt keys are bound to the canonical
  Relay API origin plus Relay agent id, not to a mutable local account label.
  Renaming an account therefore retains its cursor. A missing identity starts
  at cursor zero; corrupt, mismatched, unreadable, or unwritable state fails
  closed instead of replaying retained history. The cursor namespace rejects
  new identities at capacity rather than evicting an older cursor. Cursor
  state is independent of the bounded 30-day attempt-dedupe horizon. Both
  namespaces are private, lock-protected, atomically replaced Relay-owned
  files under `$OPENCLAW_STATE_DIR/relay/state` (normally
  `~/.openclaw/relay/state`); the plugin never requests trusted-only OpenClaw
  host SQLite access.
- Before polling, the plugin takes an atomic per-origin/per-agent filesystem
  lock under `~/.openclaw/relay/consumer-locks`. A second OpenClaw process
  fails closed; a lock whose recorded PID is dead is recovered on startup.
  Shutdown aborts the active long poll and releases both process-local and
  filesystem ownership before a replacement starts.
- Every API operation has a deadline (15 seconds for ordinary calls; the
  configured long-poll hold plus 15 seconds for event polling). A retried send
  carries the id its first attempt used.

## v1 scope

Direct conversations only. Inbound text renders as-is; inbound media and
voice memos render as a labeled fetchable capability URL (the URL is itself
the authorization, so no Agent Token is needed to fetch the bytes) rather
than the agent seeing the file inline; reactions are observe-only; receipts
(`message.delivered`/`message.read`) never start a turn. Final agent replies
are delivered durably (chunked to Relay's 8 KiB per-part cap and retry-safe
on the id each send minted).
