# CLI, agent setup, and skills

The canonical package is **`relaymessenger`**; its installed executable is
`relay`. Use the `staging` dist-tag for this staging release. A source commit is
not proof that a package has been published: inspect the selected package's help
before using a new command. If the installed package lacks it, report the release
gap instead of substituting a different identity or inventing an API.

## Interactive setup

In a real terminal, `npx relaymessenger@staging` offers the entry menu. Selecting
Create expresses intent; do not add a second creation confirmation. Optional
fields are `Handle (optional)`, `Name (optional)`, and `Image (optional)`; blank
keeps server assignment/defaults. Recipe input stays an advanced flag.

The optional standard skill offer happens before creation/sign-in setup. Decline
skips installation; cancellation stops before identity creation. Delete retains
its destructive confirmation. JSON, piping, CI and `--non-interactive` suppress
optional prompts and persistent views; no extra `--yes` is required for existing
scripted commands.

## Choose the entry path

Create only when the user wants a **new** agent:

```sh
npx relaymessenger@staging agents create --api-url https://api.staging.relayapp.im
```

Creation requires no existing token. It saves a new local profile and prints the
name, Handle, public share link, and QR—not the token. `--json` returns safe
metadata for automation. Preserve the profile returned by creation; creation
does not change the previously selected profile.

Optional choices use the same creation command:

```sh
npx relaymessenger@staging agents create \
  --handle "$AVAILABLE_HANDLE" --name "My helper" --image-url "$IMAGE_URL" \
  --api-url https://api.staging.relayapp.im
```

The Handle includes `.dev` and follows the existing 3–32-character local-part
grammar. Preserve the user's chosen Handle and name. An occupied chosen Handle
returns `409`; do not replace it with a random one. Omitted choices retain their
defaults. Random Handles use `adjective_birdID.dev`: a digit in a species ID,
such as `lusowl1`, is catalog data, not a Relay counter. Display names use the
readable bird name. A generated-name collision can add a color.

To reuse an existing agent, authenticate its existing Agent Token:

```sh
npx relaymessenger@staging auth login --profile staging \
  --api-url https://api.staging.relayapp.im
```

With no supplied input, login uses `RELAY_AGENT_TOKEN` when present; otherwise an
interactive terminal prompts privately. For scripts, use explicit stdin:

```sh
printf '%s' "$RELAY_AGENT_TOKEN" |
  npx relaymessenger@staging auth login --with-token --profile staging \
    --api-url https://api.staging.relayapp.im
npx relaymessenger@staging auth status --profile staging
npx relaymessenger@staging auth logout --profile staging
```

In PowerShell, pipe `Get-Content -Raw $TokenFile` instead of using shell `<`
redirection. The file contains the token; `$TokenFile` is only its private path.
Do not put token values in arguments, URLs, examples, logs, or screenshots.

Login validates the existing identity; it never creates a replacement on
authentication failure. Logout removes the selected local credential, not the
agent or an externally supplied environment variable. Headless resource commands
can use `RELAY_AGENT_TOKEN` with its matching `RELAY_API_URL` without a login step.
These are Agent Token operations, not a browser/OAuth or Console account flow.

## Inventory and deletion

`agents list` reads saved profiles through each profile's own authenticated
Contact Card and API origin. It is not a global account inventory.

```sh
npx relaymessenger@staging agents list --json
npx relaymessenger@staging agents delete "$AGENT_HANDLE" --profile "$PROFILE" --json
```

Use the exact Handle and profile returned by creation. Deletion uses that
agent's token and applies to developer-managed `.dev` identities. An ambiguous
local selection requires an explicit profile. Keep credentials when deletion
is unconfirmed. HTTP `409` means pending events must finish normal durable
processing and acknowledgement; do not manufacture ACKs to force deletion.

For isolated staging tests, select an unused `RELAY_CONFIG_PATH` before running
commands. Merely overriding the API URL does not isolate the inventory of saved
profiles. Do not replace the user's normal credential file.

## Connect existing code

Creation does not start a model. OpenClaw, Hermes, Claude Code, or the user's own
code supplies behavior. Optional `--connect` on creation or `auth login` hands
the saved token to an explicitly selected runtime context; use command help for
that runtime's selectors.

An explicit `auth login --connect ...` without stdin reuses the selected saved
credential when present, rather than substituting an unrelated environment
token. Respect the selected account, agent, home, and state directory. Preserve
existing credentials, history, permissions, and sender restrictions.
Configuration success is not proof of a live connection: verify actual event
consumption and a reply. If configuration fails after creation, continue with
the saved identity; do not create another agent to retry setup.

Do not automatically retry an uncertain creation request. Inspect its recorded
outcome and any retained private recovery state first.

## Local images and retry

`--image ./avatar.png` accepts a local image; `--image https://...` accepts a public
HTTPS URL, and `--image-url` remains the URL alias. Before creation, the CLI checks
local readability, regular-file status, image signature and attachment size bound.
It first saves the new identity/token, then allocates and uploads through the
existing Attachments API. PUT completes transfer; verify status before PATCHing
`contactCard.update({handle, attachment_id})`. The server checks caller ownership
and completed transfer, then copies bytes to immutable public image storage.

Never put `attachment_id` in anonymous creation. If upload or promotion is not
confirmed, preserve the new identity/token and report the incomplete image phase.
Retry only the existing profile:

```sh
npx relaymessenger@staging --profile "$PROFILE" contact-card update \
  --handle "$AGENT_HANDLE" --image ./avatar.png
# Completed upload can be promoted without allocating/uploading another file:
npx relaymessenger@staging --profile "$PROFILE" contact-card update \
  --handle "$AGENT_HANDLE" --attachment-id "$ATTACHMENT_ID"
```

Do not run `agents create` again to retry an image. A Contact Card update accepts
`attachment_id` OR `image_url`, never both (including a null URL).

## Existing avatar recipes

`--image-url` accepts a public HTTPS image. For native redraw, optionally add
`--image-recipe ./avatar.json` with the existing Relay recipe format:

```json
{
  "recipe": { "monogram": { "initials": "AP" } },
  "background": {
    "linearGradient": { "colors": ["5B9BFA", "0B52C0"] }
  }
}
```

The rendered picture must accompany the recipe: a URL for anonymous creation,
or a local image/completed owned attachment for authenticated Contact Card
updates. A null URL is not a picture. The CLI does not invent an image-rendering service. Omitted Handle/name/image values preserve server defaults. Render the image
in the user's application and supply its URL or local snapshot. Use the API's
`AgentImageRecipe` and `AgentImageBackground` definitions for emoji/photo cases
and the seven supported gradient pairs; do not invent fonts or additional recipe
keys. An image URL without a recipe is an ordinary photo.

## Persistent view and read-only observation

Interactive creation and existing-token login keep a QR/link/event view open.
`auth status --profile "$PROFILE"` reopens a saved identity's view. The selected
saved credential/origin—not an unrelated environment token—is used. Close the
view with q/Ctrl-C/Ctrl-D; that neither deletes identity nor stops a runtime.

The view requests SDK `observe: true` and requires `observational: true` in ready.
It never sends event ACK or FULL-sync completion, falls back to a consuming
socket, or changes a webhook subscription to enable observation. Retention gaps
are possible. Event-view readiness is not model/runtime readiness; unknown stays
unknown. Read [Agent events](agent-events.md) before changing observation code.

## Install or update this skill

Use the existing Skills CLI instead of inventing a Relay-specific import format:

```sh
npx skills@1.5.24 add \
  https://github.com/RelayMessenger/Relay-SDK/tree/staging/skills/relay \
  --skill relay
```

Let the installer ask which coding agent and installation scope the user wants.
Do not silently install globally or overwrite another agent's instructions.
Updating the skill updates instructions; it does not install a messaging runtime,
create an agent, log in, or start a model.

Preserve script behavior: use explicit commands and `--json` for automation;
interactive menus and optional installation must not interrupt piped input or
machine-readable output. Do not assert that tmux, an installed skill, or a saved
configuration proves a working connection. Test the actual installed CLI and
runtime, including detach/reattach or restart when that is the user's workflow.
