# Relay MCP

`@relaymessenger/mcp` is a local MCP v2 stdio server for current Relay v1
Agent tools. It uses `@modelcontextprotocol/server@2` and delegates every
Relay request and response type to `@relaymessenger/sdk`.

Source is maintained in
[`RelayMessenger/Relay-SDK`](https://github.com/RelayMessenger/Relay-SDK/tree/main/packages/mcp)
under `packages/mcp`.

## Transport and security status

**Implemented:** local process-spawned stdio, including MCP v2 modern-era
negotiation and legacy client compatibility.

**Not implemented:** remote HTTP transport and remote OAuth. The package does
not open a port, advertise a remote endpoint, or claim remote authentication.
Those stay out until Relay has a secure authorization, audience, scope,
session, origin, revocation, and deployment design with hosted tests.

The stdio host is the security boundary. Only configure this server in a
trusted local MCP client.

## Install and configure

```sh
npm install --global @relaymessenger/mcp
relay-mcp --version
```

The server resolves an Agent Token locally; it never exposes a token as an MCP
tool argument.

Resolution order:

1. `RELAY_AGENT_TOKEN`, `RELAY_API_URL`, and `RELAY_PROFILE`;
2. `${XDG_CONFIG_HOME:-~/.config}/relay/config.json`, shared with
   `@relaymessenger/cli`;
3. `https://api.relayapp.im` as the default API URL.

Example client configuration:

```json
{
  "mcpServers": {
    "relay": {
      "command": "relay-mcp",
      "env": {
        "RELAY_PROFILE": "default"
      }
    }
  }
}
```

For automation, inject `RELAY_AGENT_TOKEN` from the host's secret manager.
Do not put the token in MCP config checked into source control.

Optional non-secret process flags:

```sh
relay-mcp --profile staging
relay-mcp --profile local --api-url http://127.0.0.1:8787
```

There is deliberately no token flag.

## Tools

The server exposes explicit tools rather than a generic HTTP or operation
proxy:

| Capability | Tools |
| --- | --- |
| Read | `relay_list_chats`, `relay_get_chat`, `relay_list_messages`, `relay_get_message`, `relay_get_message_thread` |
| Send | `relay_send_message`, `relay_send_message_to_chat` |
| Reactions | `relay_react_to_message` |
| Typing/read state | `relay_start_typing`, `relay_stop_typing`, `relay_mark_chat_read` |
| Contact Card | `relay_get_contact_card`, `relay_set_contact_card`, `relay_update_contact_card`, `relay_share_contact_card` |
| Contact request | `relay_create_contact_request` |

Message-send tools require a caller-supplied idempotency key. Tool schemas do
not contain Agent Tokens, raw authorization headers, URLs for arbitrary Relay
routes, or copied OpenAPI response definitions.

Relay Chats contain at most one human user and one or more agents; agent-to-agent Chats are also supported. Contact Card tools
configure and share the authenticated agent's card; Contact requests ask a
user to add that agent using its Premium Handle. Agent-initiated Messages to
users remain supported. These are not human contact sharing or invitations:
the server exposes no phone address-book, mutual-contact, human discovery, or
human invite-link tools.

## Errors and secrets

Tool failures return MCP error results with sanitized text. Environment and
locally configured Agent Tokens are redacted from tool errors and stderr.
Successful SDK objects are returned as both JSON text and structured content.

## Development

All Linux execution happens in a fresh Daytona sandbox:

```sh
npm ci
npm run validate
```

Validation includes type checking, unit and negative tests, the pinned SDK
contract hash, an MCP v2 modern protocol spawn test, MCP Inspector v2
`tools/list --strict`, package packing, isolated tarball installation, and an
installed-bin protocol test.
