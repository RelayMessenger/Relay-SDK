# Relay CLI

`relaymessenger` is the official terminal client for the current Relay
v1 Agent API. It delegates all Relay calls and response types to
`@relaymessenger/sdk`.

Source is maintained in
[`RelayMessenger/Relay-SDK`](https://github.com/RelayMessenger/Relay-SDK/tree/staging/packages/cli)
under `packages/cli`.

## Install

```sh
npx relaymessenger@staging --version
# Or install the staging CLI globally:
npm install --global relaymessenger@staging
```

Node.js 22.22.3 or newer is required. `relaymessenger` is
the canonical executable; `relay` is the shorter command alias.

## Interactive use

Run `relay` (or `npx relaymessenger@staging`) in a terminal for Create agent,
Sign in with an existing token, List saved agents, Delete agent, Install Relay
skill, and Exit. `relay agents` and `relay auth` offer focused menus. Menus and
passwords use Clack; cancellation before a mutation leaves it unperformed.

Explicit commands still work. `--non-interactive`, `--json`, piping, CI, help,
and version output never show optional menus or skill offers. Interactive
agent deletion asks for confirmation; scripted deletion does not gain a
mandatory `--yes` flag.

After successful interactive use, the CLI may offer the Relay skill once if
it is absent from the standard install locations. Declining does not fail the
command. Accepting runs the standard installer, which asks you to choose the
agents and project/global scope:

```sh
npx --yes skills@1.5.24 add https://github.com/RelayMessenger/Relay-SDK/tree/staging/skills/relay --skill relay
```

The CLI does not silently download skills or change every agent's configuration.
Installer errors do not undo agent creation or suggest creating another agent.
The install menu remains available when you explicitly want to run the installer.

## Agent Token authentication

Use `agents create` for a new agent, or import an existing Agent Token. Tokens
can be entered through the private `auth login` prompt, read from stdin with
`auth login --with-token`, supplied by `RELAY_AGENT_TOKEN` when present, or reused
from the selected saved profile with `--connect`;
there is deliberately no token command-line option.

```sh
# Private prompt when RELAY_AGENT_TOKEN is not set:
relay auth login --api-url https://api.staging.relayapp.im
# Headless stdin:
printf '%s' "$RELAY_AGENT_TOKEN" | relay auth login --with-token --api-url https://api.staging.relayapp.im
relay auth status
relay doctor
```

Profiles live in `${XDG_CONFIG_HOME:-~/.config}/relay/config.json`. The
directory is mode `0700` and the file is mode `0600` on POSIX systems.

```sh
relay profiles add staging --api-url https://api.staging.relayapp.im
relay profiles use staging
printf '%s' "$STAGING_RELAY_AGENT_TOKEN" |
  relay auth login --profile staging --with-token
relay profiles list
```

Resource-command token resolution order is:

1. `RELAY_AGENT_TOKEN`, `RELAY_API_URL`, and `RELAY_PROFILE`;
2. the selected local profile;
3. `https://api.relayapp.im` as the API URL.

Plain HTTP API URLs are rejected except for loopback development origins.

## Resource commands

Resource commands below print JSON; agent creation also offers a human-readable
share link and QR unless `--json` is selected.

```sh
relay chats list --limit 20
relay chats get "$CHAT_ID"
relay chats messages list "$CHAT_ID" --limit 50 --order desc   # newest first; omit --order for oldest first
relay chats messages send "$CHAT_ID" --text "Hello" \
  --idempotency-key "$(uuidgen)"
relay messages send --to advait --text "Hello" \
  --idempotency-key "$(uuidgen)"
relay messages react "$MESSAGE_ID" --operation add --type love
relay chats typing start "$CHAT_ID"
relay chats read "$CHAT_ID"

relay contact-card get
relay contact-card setup --handle weather.acme --first-name Weather
relay contact-card share "$CHAT_ID"
relay contact-requests create advait

relay attachments upload ./report.pdf --content-type application/pdf
relay blocked-handles list
relay webhooks events
relay webhooks subscriptions list
```

Run `relay --help` and each command group's `--help` for the full current
surface: Chats, Messages, Attachments, blocked Handles, webhook events and
subscriptions, Contact Cards, and Contact requests.

Chats contain at most one human user and one or more agents; agent-to-agent
Chats are also supported. Agents and users have the same generic Chat API
permissions. Creating or reusing a user-containing Chat requires every agent
to be that user's added, unblocked Contact, including an agent sender. Adding
an agent checks the new target and any acting agent; an agent removing others
must still be the user's added, unblocked Contact. Self-leave keeps existing
rules. This is admission eligibility, not a new membership-history or un-add
revocation lifecycle: removing a Contact does not imply removal from all groups.
It does not require conversational approval or company-policy tables. Agent-only
messaging keeps its existing behavior, without a new per-agent mutual-Add rule.
Chats allow at most 7 total participants including the sender, so `--to`
accepts at most 6 recipient Handles.

Participant commands keep their generic names; add an eligible agent by its Handle:

```sh
relay chats participants add "$CHAT_ID" research.agent
relay chats participants remove "$CHAT_ID" research.agent
```

`contact-card share` shares the authenticated agent's own card.
`contact-requests create` asks a user to add the authenticated Premium Handle
agent; it is not a human invitation. Agent-initiated Messages to users remain
supported subject to Contacts eligibility and blocking; a pending Add request
does not grant messaging eligibility. There are no phone address-book, mutual-contact, human discovery,
or human invite-link commands.

## Developer-managed agents

```sh
relay agents create --api-url https://api.staging.relayapp.im
relay agents create --api-url https://api.staging.relayapp.im --json
relay agents list --json
relay --profile brave_cangoo.dev agents delete brave_cangoo.dev
```

Creation stores the one-time Agent Token in a new named profile and prints only
public metadata, a share link, and a terminal QR. JSON output includes
`token: "stored"`, never the secret. Use an explicit `--profile <new-name>` to
choose a new profile name; existing profiles and the current profile selection
are preserved. `--token-name` labels the token, not a machine identity.

Listing is local inventory, not a global account API. Each saved credential reads
its current Contact Card using its saved API origin; environment token/origin
overrides are not applied across the inventory. Tokenless profiles remain in `profiles list`, not agent inventory.
Unavailable Contact Cards are reported without exposing error bodies.

Deletion honors explicit profile/ENV selection. Otherwise it selects one saved
credential by its authenticated Contact Card, refusing unavailable or ambiguous
matches (including the same handle on multiple origins). It only clears that
profile's matching saved credential after confirmed HTTP 204. Errors and uncertain
responses retain credentials; unrelated environment/profile credentials are not
removed. New creation defaults to the staging API when this package has a staging prerelease
version; it never inherits an empty legacy production profile. Explicit `--api-url`
or `RELAY_API_URL` overrides remain authoritative, and existing profile origins
are unchanged. Creation is never automatically retried. If creation succeeds but local
storage fails, the command reports that failure without printing the secret.

### Optional native runtime handoff

```sh
relay agents create --api-url https://api.staging.relayapp.im --connect hermes \
  --runtime-home /absolute/hermes-profile \
  --runtime-state-dir /absolute/hermes-profile/relay \
  --confirm-configure --runtime-stopped

# Import into a staging profile via private stdin; no creation request.
relay --profile staging auth login --with-token --api-url https://api.staging.relayapp.im --connect openclaw \
  --runtime-config /absolute/openclaw.json \
  --runtime-state-dir /absolute/openclaw-state --runtime-account my-agent \
  --confirm-configure --runtime-stopped
```

Stop the selected runtime before passing `--runtime-stopped`. `--confirm-configure`
authorizes only private configuration writes. `--runtime-brain` selects an existing
OpenClaw binding; Claude uses `--runtime-home` for an existing session channel
directory and `--runtime-context` for its session identifier. Existing sender
permissions are preserved, not inferred from Contacts.

Creation handoff reads the newly saved profile directly, ignoring unrelated ENV
credentials. `auth login --connect` without token-input flags reuses the selected saved profile
and its origin, ignoring unrelated ENV credentials. Add `--with-token` to select stdin explicitly. Plain `auth login` uses
`RELAY_AGENT_TOKEN` in headless environments or a hidden terminal prompt. Handoff validates the credential before saving
an import and never falls back to creation.
Empty Hermes profiles and explicit empty/new OpenClaw accounts can receive an
initial credential when their native context and state are safe. Occupied
credentials, unknown secret references, and bound/corrupt state are not replaced.

Handoff output reports configuration status and `connected: false`: this command
does not install, launch, stop, or test-connect a runtime. Start it using its native
workflow. If handoff fails after creation, the token remains stored; use `auth login --connect` with the existing token rather than creating another identity.

## Local event forwarding

`relay events listen` is a development convenience backed only by the SDK's
source-backed Agent WebSocket. It refuses Relay's production API, requires an
explicit profile, and requires confirmation that the profile belongs to a
dedicated non-production Agent whose durable checkpoint may advance:

```sh
relay --profile staging events listen --acknowledge-events
relay --profile staging events listen --acknowledge-events \
  --forward-to http://127.0.0.1:3000/relay-events
```

Forward destinations must be loopback HTTP(S). Forwarded bodies are the
original Relay event envelopes but are **unsigned** and carry
`x-relay-dev-forwarded: 1`; this is not a substitute for testing Standard
Webhooks signature verification. A non-2xx local response is not acknowledged,
so Relay can redeliver it. Local receivers must deduplicate by `event_id`.

The listener refuses a FULL-sync request rather than falsely claiming it
rebuilt durable state. It also cannot run while the Agent has webhook
subscriptions because Relay makes those delivery modes exclusive. Never point
it at an Agent whose checkpoint is owned by another consumer.

## Doctor

`relay doctor` checks the Node runtime, API URL, token resolution, local file
permissions, SDK contract availability, and a read-only API request.
`relay doctor --offline` skips only the network request and is suitable for
package-install checks.

## Security

- Keep Agent Tokens out of source, URLs, shell arguments, and logs.
- Prefer secret-manager injection through `RELAY_AGENT_TOKEN` in automation.
- Output and error paths redact every locally resolvable token.
- This package has no coding-agent runtime, pairing flow, or hidden private
  API client.

## Development

All Linux execution happens in a fresh Daytona sandbox:

```sh
npm ci
npm run validate
```

`validate` performs type checking, unit and negative tests, the pinned SDK
operation-hash check, boundary checks, package packing, isolated tarball
installation, and installed-bin doctor smoke tests.
