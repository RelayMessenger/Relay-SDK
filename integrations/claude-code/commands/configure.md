---
description: Configure and verify the self-contained Relay channel
---

Configure Relay without asking the user to paste or echo a secret in chat.

1. Use the paired relayapp flow. Ask the user to run these locally if needed:

   ```text
   relayapp pair
   relayapp install-claude
   ```

   `install-claude` copies the paired token, API origin, and pinned owner into
   the channel `.env` with current-user-only permissions. It never prints the
   token and refuses to overwrite a different configured channel identity.

2. Determine the user's channel directory using their platform conventions:
   `~/.claude/channels/relay` on macOS/Linux or
   `%USERPROFILE%\.claude\channels\relay` on Windows. Create it with access
   restricted to the current user.

   Verify that `.env` exists. Do not read or display its contents.

3. If relayapp is unavailable and the user already obtained an Agent Token
   through another secure route, they may create `.env` themselves with
   current-user-only access:

   ```dotenv
   RELAY_AGENT_TOKEN=
   RELAY_BASE_URL=https://api.relayapp.im
   #RELAY_OWNER_USER_ID=usr_...
   #RELAY_CHANNEL_SESSION_ID=my-repository
   #RELAY_ALLOW_TOFU=1
   ```

   `RELAY_ALLOW_TOFU=1` is an explicit fallback only for an agent no one else
   can message. Normally the owner comes from `GET /v1/agents/me`.

   Never request, print, or place the token in a command argument.

4. Do not run `npm install`. The installed plugin's
   `runtime/server.mjs` already contains its runtime dependencies.

5. After the user confirms the file is ready, run this from the installed
   plugin directory using a platform-native path:

   ```text
   node runtime/server.mjs --check
   ```

   Report only success, agent id, or the sanitized error. Never display the
   `.env` file or token. The check also rejects non-HTTPS remote origins.

6. Explain how to start the research-preview channel:

   ```text
   claude --dangerously-load-development-channels plugin:relay@<marketplace>
   ```

   Use `server:relay` for a bare MCP registration. The agent must not have a
   webhook enabled, and only one live Claude session can consume that agent.

7. Ask the user to message the agent from Relay. Explain that messages are
   delivered at least once until Claude acknowledges them. Permission cards
   upload the displayed tool details to Relay history; an incomplete
   200-character Claude preview can be denied remotely but must be approved at
   the local terminal.
