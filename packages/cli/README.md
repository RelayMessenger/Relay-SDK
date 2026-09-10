# Relay CLI

`relaymessenger` is the official terminal client for the current Relay
v1 Agent API. It delegates all Relay calls and response types to
`@relaymessenger/sdk`.

Source is maintained in
[`RelayMessenger/Relay-SDK`](https://github.com/RelayMessenger/Relay-SDK/tree/staging/packages/cli)
under `packages/cli`.

## Install

```sh
npx relaymessenger --version
# Or install the CLI globally:
npm install --global relaymessenger
```

Node.js 22.22.3 or newer is required. `relaymessenger` is
the canonical executable; `relay` is the shorter command alias.

## The front door

```sh
npx relaymessenger connect            # asks what will answer as this agent
npx relaymessenger connect claude     # names it outright
```

`connect` finds the runtimes on this computer, makes an agent or takes one you
already have, shows every file it will write and every command it will run,
writes the runtime's own configuration, waits for a first message and asks
whether to allow that sender, then offers to start the runtime. This build
writes Claude Code; Hermes and OpenClaw are detected, their plan is printed, and
the command stops without changing anything.

Every question has a flag for scripts: `--new`, `--handle`, `--name`, `--image`,
`--token`, `--allow`, `--yes`, `--dry-run`, `--no-start`, `--no-skill`, `--json`
and `--api-url`. `--dry-run` prints the plan and changes nothing.

## Interactive use

Run `relay` (or `npx relaymessenger`) in a terminal for Connect an agent, Watch
an agent, and Exit. `relay agents` and `relay auth` offer focused menus. Menus
and passwords use Clack; cancellation before a mutation leaves it unperformed.

Whether Relay asks anything is decided by the terminal and the flags, and by
nothing else: a `CI` variable no longer suppresses a menu. Explicit commands
still work. `--non-interactive`, `--json`, piping, help, and version output never
show optional menus or skill offers. Interactive agent deletion asks for
confirmation; scripted deletion does not gain a mandatory `--yes` flag.

With no terminal, a command that needs an answer prints the flags that would
have answered it and exits 2 rather than a usage block. With `--json`, every
error is `{ "error": …, "next_step": … }`.

`relay --help` puts the commands in three groups: Get started (`connect`), Every
day (`watch`, `doctor`, `agents`), and Everything else behind one line. Every
command has a description; run `relay help <command>` for any of them.

Before interactive creation or sign-in setup, the CLI may offer the Relay skill
once if it is absent from the standard install locations. Declining skips skill
installation; cancelling stops setup before any identity is created. Accepting runs the standard installer, which asks you to choose the
agents and project/global scope:

```sh
npx --yes skills@1.5.25 add https://github.com/RelayMessenger/Relay-SDK/tree/staging/skills/relay --skill relay
```

The CLI does not silently download skills or change every agent's configuration.
Optional installer errors are reported before setup proceeds and never repeat
an agent creation. An explicit install-only failure exits nonzero. Selected `CODEX_HOME`,
`CLAUDE_CONFIG_DIR`, and `HERMES_HOME` locations are preserved and checked; explicit
`DISABLE_TELEMETRY` and `DO_NOT_TRACK` preferences are passed to the installer.
The install menu remains available when you explicitly want to run the installer.

### Persistent agent view

`relay watch <handle>` opens the live view: the public QR and link, and the
events as they arrive. Successful interactive creation and sign-in keep the same
view open. Press `q`, Ctrl-C, or Ctrl-D to close it; it does not delete the agent
or stop a runtime. `relay events listen` is the older name for a different thing:
it takes events, so Relay can stop resending them elsewhere. It keeps working and
keeps its flags, and it is no longer listed in the help.

The view only watches. Your agent still receives every message, because this view
never answers Relay and never takes an event from it. It shows the events Relay
still holds, so some earlier ones may be missing, and it says so on screen when
they are. A connected view does not mean the agent is running, and the screen
says that too. `--json`, `--non-interactive`, and any command not attached to a
terminal never open this view.

## Agent Token authentication

Use `agents create` for a new agent, or import an existing Agent Token. Tokens
can be entered through the private `auth login` prompt, read from stdin with
`auth login --with-token`, or supplied by `RELAY_AGENT_TOKEN` when present.

```sh
# Private prompt when RELAY_AGENT_TOKEN is not set:
relay auth login
# Headless stdin:
printf '%s' "$RELAY_AGENT_TOKEN" | relay auth login --with-token
relay auth status
relay doctor
```

Profiles live in `${XDG_CONFIG_HOME:-~/.config}/relay/config.json`. The
directory is mode `0700` and the file is mode `0600` on POSIX systems.

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
relay contact-card setup --handle weather.dev --name Weather
relay contact-card share "$CHAT_ID"

relay attachments upload ./report.pdf --content-type application/pdf
relay blocked-handles list
relay webhooks events
relay webhooks subscriptions list
```

Run `relay --help` and each command group's `--help` for the full current
surface: Chats, Messages, Attachments, blocked Handles, webhook events and
subscriptions, and Contact Cards.

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
relay chats participants add "$CHAT_ID" research.dev
relay chats participants remove "$CHAT_ID" research.dev
```

`contact-card share` shares the authenticated agent's own card. Agent-initiated
Messages to users remain supported subject to Contacts eligibility and blocking.
There are no add-request, phone address-book, mutual-contact, human discovery, or
human invite-link commands.

## Developer-managed agents

```sh
relay agents create
relay agents create --json
relay agents list --json
relay --profile brave_cangoo.dev agents delete brave_cangoo.dev
```

Creation stores the one-time Agent Token in a new named profile and prints only
public metadata, a share link, and a terminal QR. JSON output includes
`token: "stored"`, never the secret. Use an explicit `--profile <new-name>` to
choose a new profile name; existing profiles and the current profile selection
are preserved. `--token-name` labels the token, not a machine identity.

`agents list` shows the agents saved on this computer, not every agent on your
account. Each row is `profile`, `handle`, `display_name`, `image_url`, `api_url`
and `token: "stored"`. Each row is read with that profile's own token and API
address, so a token in your environment never stands in for another profile. A
profile with no token stays in `profiles list` and is not shown here. A row Relay
cannot answer for reads `error: "Agent details unavailable"`, with nothing from
the failed answer repeated.

Deletion honors explicit profile/ENV selection. Otherwise it selects one saved
credential by its authenticated Contact Card, refusing unavailable or ambiguous
matches (including the same handle on multiple origins). It only clears that
profile's matching saved token after Relay confirms the agent is gone. If Relay
errors, or does not answer, the saved token stays; tokens for other profiles and
for your environment are never touched. New creation defaults to the staging API when this package has a staging prerelease
version; it never inherits an empty legacy production profile. Explicit `--api-url`
or `RELAY_API_URL` overrides remain authoritative, and existing profile origins
are unchanged. Creation is never automatically retried. If creation succeeds but local
storage fails, the command reports the safely assigned handle and whether local
storage is present, absent, or unverified, without printing the secret. Relay
checks that it can write a private config file before it asks Relay to create the
agent, and it never overwrites a token that is already there.

### Optional identity and picture

```sh
relay agents create \
  --handle my_helper.dev --name "My Helper" \
  --image-url https://images.example.com/helper.png
```

Omit any option to keep the server's assigned handle/readable bird name/default
image. Custom handles are full lowercase `.dev` handles; a collision is an error,
never a request for a random replacement. Interactive creation asks `Handle (optional)`, `Name (optional)`, and `Image
(optional)` with a single help line; blank answers preserve defaults. Selecting
Create already expresses intent, so no second create confirmation is shown.
Recipe files remain an advanced `--image-recipe` flag, not another setup question.

`--image <path-or-url>` accepts a local supported image or public HTTPS URL;
`--image-url` remains a URL alias. The CLI checks a local file's readability,
size, and image signature before creation. Once the new token is privately saved,
it allocates/uploads through the existing Attachments API, checks completion,
and updates the Contact Card using the completed `attachment_id`.

If image upload/promotion is not confirmed, the new identity and saved profile
are retained, and the command reports the incomplete image phase. Retry the
image on that existing identity—do not run `agents create` again:

```sh
relay --profile my_helper.dev contact-card update --handle my_helper.dev --image ./helper.png
# If upload completed but promotion failed, reuse the returned attachment ID:
relay --profile my_helper.dev contact-card update --handle my_helper.dev --attachment-id <completed-id>
```

`--image-recipe <json-file>` remains an advanced flag for existing Relay avatar
metadata, paired with its rendered local image/URL/attachment. It is not a default
interactive question. The CLI does not render recipes or generate images. The
server's response supplies the permanent public image URL.

## Local event forwarding

`relay events listen` is a development convenience backed only by the SDK's
source-backed Agent WebSocket. It refuses Relay's production API, requires an
explicit profile, and asks you to confirm that the profile belongs to a test agent.
Reading events here can make Relay stop resending them elsewhere, so never point it
at an agent something else is reading:

```sh
relay --profile staging events listen --acknowledge-events
relay --profile staging events listen --acknowledge-events \
  --forward-to http://127.0.0.1:3000/relay-events
```

`--forward-to` must be an address on your own computer, such as
`http://127.0.0.1:3000`. Each copy is the original Relay event, but it is **not
signed**, and it carries `x-relay-dev-forwarded: 1`. Use a real webhook to test
signature checking. If your own address answers with an error, this command stops
rather than let the event be lost, so Relay can send it again. Your receiver must
ignore an `event_id` it has already seen.

If the agent has been away longer than Relay keeps its events, Relay wants to send
everything it missed. This command cannot go back over old events and says so
instead of pretending. It also cannot run while the agent has webhook
subscriptions, because Relay sends events one way or the other, never both.

## Doctor

`relay doctor` checks your Node.js version, the Relay API address, which token
Relay would use, the permissions on your config file, the installed
`@relaymessenger/sdk`, and whether Relay answers. `relay doctor --offline` skips
only the last of those, which suits a check right after installing.

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

## Staging

Install `relaymessenger@staging` to work against the staging environment:

```sh
npx relaymessenger@staging --version
npm install --global relaymessenger@staging
```

That build talks to `https://api.staging.relayapp.im` on its own and installs
the Relay skill from the repository's `staging` branch; a plain `relaymessenger`
build talks to `https://api.relayapp.im` and installs from `main`. Either way an
explicit `--api-url` or `RELAY_API_URL` still wins, for example:

```sh
relay profiles add staging --api-url https://api.staging.relayapp.im
relay profiles use staging
printf '%s' "$STAGING_RELAY_AGENT_TOKEN" |
  relay auth login --profile staging --with-token
relay profiles list
```
