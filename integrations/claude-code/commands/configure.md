---
description: Set up the Relay channel — credentials file, dependency install, and connectivity check
---

Configure the Relay channel for Claude Code. Follow these steps in order.

1. **Create the credentials directory and file.** The channel server reads
   `~/.claude/channels/relay/.env`. Create the directory if needed and write a
   template file if one does not exist:

   ```
   mkdir -p ~/.claude/channels/relay
   chmod 700 ~/.claude/channels/relay
   ```

   Template for `~/.claude/channels/relay/.env` (mode 600):

   ```
   # Relay agent credentials for the Claude Code channel
   RELAY_AGENT_TOKEN=
   RELAY_BASE_URL=https://api.relayapp.im
   # Pin the only user allowed to reach this session (usr_…). If unset, the
   # owner is looked up from GET /v1/agents/me; if that fails too, the
   # channel refuses to start (fail closed).
   #RELAY_OWNER_USER_ID=
   # Explicit opt-in: pin the FIRST user who messages the agent as owner.
   # Only for private agents the user alone can message.
   #RELAY_ALLOW_TOFU=1
   ```

2. **Have the user add their Agent Token.** Never ask the user to paste the
   token into chat and never echo it. Tell them: open the Relay app, create or
   open their agent, copy the Agent Token, and paste it after
   `RELAY_AGENT_TOKEN=` in `~/.claude/channels/relay/.env` in their own editor.
   For staging, set `RELAY_BASE_URL=https://api.staging.relayapp.im`.

3. **Install server dependencies** in the plugin directory (the MCP server
   needs `node_modules` next to `server.ts`). Run `npm install --omit=dev` in
   the plugin root (the directory containing this plugin's `package.json`).
   Node >= 22.18 is required (the server runs TypeScript natively).

4. **Verify the token** once the user says the file is filled in. Without
   printing the token, run a connectivity check:

   ```
   set -a; source ~/.claude/channels/relay/.env; set +a
   curl -sS -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $RELAY_AGENT_TOKEN" "${RELAY_BASE_URL:-https://api.relayapp.im}/v1/agents/me"
   ```

   `200` means the token works. `401` means the token is wrong or revoked.
   Report only the status, never the token value.

5. **Explain how to start the channel.** Channels are a research preview, so
   the session must be started with the development flag:

   ```
   claude --dangerously-load-development-channels plugin:relay@<marketplace>
   ```

   (Use `server:relay` instead if the server is registered through `.mcp.json`
   rather than as an installed plugin.) Also note: the agent must not have a
   webhook endpoint enabled — Relay's event stream is long-poll XOR webhook,
   and an enabled webhook makes `/v1/events` return `409 conflict`.

6. **Confirm the loop.** Tell the user to message their agent from the Relay
   app; the message should appear in this session as a `<channel source="relay">`
   event. Permission prompts will be relayed to the same conversation with
   Allow/Deny options, and can also be answered by texting `yes <id>` or
   `no <id>`.
