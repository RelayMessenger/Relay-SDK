# Relay Plugins

Install Relay through the native extension surface of your agent runtime. A global Relay CLI is optional.

## Integration matrix

| Target | Native package | Runtime bridge | Status |
|---|---|---|---|
| Claude Code | Marketplace plugin and channel | Claude channel MCP | Shipped via [`@relaymessenger/cli`](https://github.com/relaymessenger/cli) |
| Codex | Marketplace plugin | Codex app-server | Shipped via `@relaymessenger/cli` |
| Gemini CLI | Gemini extension | ACP | In development |
| OpenClaw | Channel plugin | OpenClaw gateway | Shipped via cli; migration landing zone in [`plugins/openclaw`](plugins/openclaw) |
| Hermes | Gateway platform | Hermes gateway | **Preview in [`plugins/hermes`](plugins/hermes)** |
| OpenCode | Plugin recipe | OpenCode server | Harness-gated |
| Pi | Extension | Pi SDK | Harness-gated |
| Cursor | Marketplace plugin | None until runtime proof | Distribution only |
| Copilot CLI | Skill and MCP recipe | None | Recipe only |
| Grok Build | Marketplace plugin | ACP | Harness-gated |
| Custom agent | `examples/showcase-agent` | `@relaymessenger/core` long-poll | **Runnable** |

## Repository layout

- [`packages/core`](packages/core): Relay transport, authorization helpers, delivery, durable cursor, webhook verify, poll loop.
- [`plugins`](plugins): Host-native packages (`hermes`, `openclaw` landing zone).
- `adapters`: Runtime bridges with streaming, cancellation, and permissions (reserved).
- [`examples`](examples): Raw webhook agent and showcase long-poll agent.
- [`harnesses`](harnesses): Manifest, packed-consumer, and production API smokes.

Native plugins read the Relay Agent Token from host secret settings or a private Relay config file. Use `relaymessenger` only for pairing, diagnostics, migrations, install convenience, or an ACP fallback bridge.

## Quick start (build your own agent)

```bash
export RELAY_AGENT_TOKEN=rly_live_...
npm ci
npm run validate
npm start -w @relaymessenger/showcase-agent
```

Message the agent from the Relay app. You should receive an echo reply.

## Development

```bash
npm ci
npm run validate
npm run manifests:check
npm run pack:check
# live API (needs RELAY_AGENT_TOKEN):
node harnesses/e2e-production.mjs
```

The e2e harness reads `RELAY_AGENT_TOKEN` from the environment, or from a
`.env` file at this repository's root. That file is gitignored; never commit
it.

## Security

Never put an Agent Token in source control. Relay state files use private file permissions and refuse identity conflicts.
