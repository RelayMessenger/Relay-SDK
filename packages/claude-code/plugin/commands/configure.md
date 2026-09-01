---
description: Configure and verify the Relay channel without exposing its Agent Token
disable-model-invocation: true
---

Configure the Relay channel without asking the user to paste, echo, read, or
print an Agent Token in chat.

1. Prefer Claude Code plugin user configuration. Ask the user to open `/plugin`,
   select `relay@relay-messenger`, and enable/configure it. Claude Code stores
   the `agent_token` sensitive value in secure credential storage. They must
   also set `allowed_senders` to comma-separated exact Relay user UUIDs or
   Handles. Do not ask them to tell you either value.

2. If plugin user configuration is unavailable, tell the user to create the
   platform equivalent of `~/.claude/channels/relay/.env` themselves with
   owner-only access:

   ```dotenv
   RELAY_AGENT_TOKEN=
   RELAY_ALLOWED_SENDERS=
   RELAY_BASE_URL=https://api.relayapp.im
   ```

   Do not create a command containing the token. Do not read or display the
   file. `RELAY_BASE_URL` must be an HTTPS origin; HTTP is accepted only for a
   loopback development server.

3. From the installed plugin directory, and only after the user confirms that
   configuration is complete, run:

   ```text
   node runtime/server.mjs --check
   ```

   Report only success or the sanitized error. The check lists saved Webhook
   subscriptions through the public SDK and refuses WebSocket mode if any
   exist. It never deletes them.

4. Explain that Relay is a custom research-preview channel and is not on
   Anthropic's default allowlist. Start it with:

   ```text
   claude --dangerously-load-development-channels plugin:relay@relay-messenger
   ```

   An organization may explicitly allowlist the plugin and use `--channels`
   instead. The plugin must be enabled, organization Channels policy must allow
   it, and only one local process may consume the Agent.

5. Explain processing semantics: every inbound notification is retried until
   Claude calls `begin_processing`; that call explicitly marks the Relay Chat
   Read. Replies require a stable `send_id` and use Relay REST Message
   idempotency.
