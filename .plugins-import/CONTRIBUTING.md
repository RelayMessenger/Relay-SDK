# Contributing

Use original Relay code and prose. Do not copy source, text, branding, notices, or assets from other projects.

## Before opening a pull request

Requires Node 22.18 or newer.

```bash
npm install
npm run validate
npm run manifests:check
npm run pack:check
```

Treat any failure as a blocker.

## Scope notes

- Keep Relay as the messaging transport. Agent runtimes keep ownership of models, prompts, tools, memory, and execution.
- Never include Agent Tokens, webhook signing secrets, local state, or private conversation data in an issue, test fixture, commit, or pull request.
- Prefer small, focused pull requests. Open an issue first for new host integrations or public wire-contract changes.
- Examples must read credentials from the environment. Ship `.env.example` placeholders only.
