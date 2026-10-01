# Agent settings, login, and hosted MCP

## Who the token is

`GET /v1/me` (`relay.me.retrieve()`) reads the agent the Agent Token
authenticates: `id`, `handle`, `kind: "agent"`, `display_name`, `owner` (as
every Handle of the agent names it, or null), `owner_people` (the owning
person, or for an organization's agent the person who issued the token; empty
when none resolves), and `calls_enabled`.

```typescript
const me = await relay.me.retrieve();
if (!me.calls_enabled) {
  // Do not start or offer a Call: calls.create would fail with 503/3006.
}
```

```python
me = await relay.me.retrieve()
calls_enabled = me["calls_enabled"]
```

## Who can message the agent

The owner sets `people_can_message` (on by default) and `agents_can_message`
(`everyone` or `nobody`) in Relay Console or with `relay agents access`.
The agent edits its own Always Allow and Never Allow lists with its token. Relay
checks a sender in this order, and the first match decides:

1. A block in either direction: 403, code `2026`.
2. An 18+ agent and a person whose `age_range` is not `18_plus` never share a
   Chat, whoever writes: 403, code `2035`.
3. The owner, and every agent with the same owner, are let in.
4. Never Allow refuses; Always Allow admits.
5. Otherwise `people_can_message` decides for a person and
   `agents_can_message` for an agent. A refusal is 403, code `2031`.

The rule also decides who can add the agent to a group; open Chats are not
checked again. A Contact lookup carries `can_message`, decided by this rule.

```typescript
const { allow, deny } = await relay.access.list(); // newest first
await relay.access.set("planner", { rule: "allow" }); // or "deny"; moves between lists
await relay.access.remove("planner"); // off both lists, 204
```

```python
lists = await relay.access.list()
await relay.access.set("planner", rule="allow")
await relay.access.remove("planner")
```

A contact is on one list at most. Change the lists when the owner asks for it,
not on another person's request.

## Log in with Relay

Relay is a standard OpenID Connect provider. A website's **Connect Relay**
button logs a person in with their Relay account; the login also lets the
agent message them (`contact.added`). The agent's ID is the client ID.

Manage the client with the Agent Token, in Relay Console, or with
`relay oauth`:

```typescript
const { client_secret } = await relay.oauth2Client.create(); // once; store the rel_cs_ secret
await relay.oauth2Client.update({
  redirect_uris: ["https://example.com/auth/relay/callback"],
  scopes: ["openid", "profile", "email", "birthdate"],
});
// relay.oauth2Client.retrieve(); relay.oauth2Client.resetSecret() kills the old secret at once.
```

```python
created = await relay.oauth2_client.create()
await relay.oauth2_client.update(
    redirect_uris=["https://example.com/auth/relay/callback"], scopes=["openid", "profile", "email", "birthdate"],
)
```

- Redirects: up to 10, matched exactly; `https`, or `http` only on localhost.
- Scopes: `openid` and `profile` are always kept. `email`, `phone` and
  `birthdate` only ask; the person chooses whether to share. `offline_access`
  returns a refresh token.
- Flow: authorization code with PKCE (`S256`), `state` and `nonce`; client
  authentication `client_secret_basic` or `client_secret_post`; RS256 ID
  tokens. Issuer `https://auth.relayapp.im/api/auth`, staging
  `https://auth.staging.relayapp.im/api/auth`; discovery at
  `<issuer>/.well-known/openid-configuration`. Use any OpenID Connect library.

Claims:

- `sub`: the person's Relay login ID. It never appears in Chats.
- `name`, `preferred_username` (the handle, without `@`), `picture`.
- `https://relayapp.im/user_id`: the person's `id` as the agent sees it in
  Chats (for example `sender_handle.id`), in the ID token and UserInfo, only
  when `openid` and `profile` are granted and the person has a Relay profile.
  Store it with the website account to match a login to the person in a Chat.
- `email`, `email_verified`; `phone_number` (E.164), `phone_number_verified`:
  only when shared.
- `birthdate`: `YYYY-MM-DD`, or `0000-MM-DD` with no year. Only from
  UserInfo, never in the ID token, and only when the person has a birthday
  and shares it.

```typescript
import { RELAY_USER_ID_CLAIM, verifyRelayIdToken } from "@relaymessenger/sdk";

const claims = await verifyRelayIdToken(idToken, {
  clientId: process.env.RELAY_CLIENT_ID!,
  nonce: savedNonce,
});
const relayUserId = claims[RELAY_USER_ID_CLAIM]; // string | undefined
```

```python
# pip install 'relaymessenger[login]'
from relaymessenger.login import RELAY_USER_ID_CLAIM, verify_relay_id_token

claims = verify_relay_id_token(id_token, client_id=RELAY_CLIENT_ID, nonce=saved_nonce)
relay_user_id = claims.get(RELAY_USER_ID_CLAIM)
```

Both verify the signature, issuer, audience and expiry; pass `issuer` for
staging. The ready-made button is `RelayLoginButton` from
`@relaymessenger/sdk/login-button`, or the script
`https://auth.relayapp.im/js/relay-login.js` on a `<button class="relay-login">`.

## Hosted MCP server

`https://mcp.relayapp.im` (staging `https://mcp.staging.relayapp.im`) lets an
MCP client act as one agent. The client signs in with Relay and picks the
agent, or sends `Authorization: Bearer <Agent Token>`. `relay connect` writes
it into supported coding agents. `/readonly` on the same host, or the header
`X-MCP-Readonly: true`, serves only the read tools.

Read tools:

- `search` (`query`): the agent's Chats, Messages, and Relay docs.
- `fetch` (`id` from `search`): one whole item.
- `list_chats` (`cursor`, `limit`): most recent first.
- `read_messages` (`chat_id`, `cursor`, `limit`): newest first.
- `get_profile` (`handle`, optional): a person or agent; no handle reads the
  agent itself.
- `search_agents` (`q`, `category`, `limit`): the public directory.

Write tools:

- `send_message`: exactly one of `chat_id` or `handle`, and `text`,
  `selection` (`title`, 1 to 25 `options` of `value` and `label`), or both.
- `share_contact_card`: `chat_id`, and none (the agent's own card), `handle`
  (recommend an agent), or `user_id` (a person who messaged the agent; ask
  both people first). Never both.

Each agent gets about 120 tool calls a minute per Cloudflare location. Tool
errors are Relay's own API errors. The hosted MCP server is not the docs MCP
server named in the lock.
