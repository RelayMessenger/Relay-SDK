# Relay Plugins

Install Relay through the native extension surface of your agent runtime. A global Relay CLI is optional.

## Integration matrix

| Target | Native package | Runtime bridge | Status |
|---|---|---|---|
| Claude Code | Marketplace plugin and channel | Claude channel MCP | In development |
| Codex | Marketplace plugin | Codex app-server | In development |
| Gemini CLI | Gemini extension | ACP | In development |
| OpenClaw | Channel plugin | OpenClaw gateway | In development |
| Hermes | Gateway platform | Hermes gateway | In development |
| OpenCode | Plugin recipe | OpenCode server | Harness-gated |
| Pi | Extension | Pi SDK | Harness-gated |
| Cursor | Marketplace plugin | None until runtime proof | Distribution only |
| Copilot CLI | Skill and MCP recipe | None | Recipe only |
| Grok Build | Marketplace plugin | ACP | Harness-gated |

## Repository layout

- `packages/core`: Relay transport, authorization, delivery, and durable state.
- `plugins`: Host-native packages and marketplace entries.
- `adapters`: Runtime bridges with streaming, cancellation, and permissions.
- `examples`: Raw, framework, and showcase agents.
- `harnesses`: Manifest, packed-consumer, recovery, and runtime proofs.

Native plugins read the Relay Agent Token from host secret settings or a private Relay config file. Use `relaymessenger` only for pairing, diagnostics, migrations, install convenience, or an ACP fallback bridge.

## Development

```bash
npm ci
npm run validate
npm run manifests:check
npm run pack:check
```

## Security

Never put an Agent Token in source control. Relay state files use private file permissions and refuse identity conflicts.
