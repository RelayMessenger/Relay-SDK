# Contributing

Relay's developer tools are open source under the MIT License. Bug reports and
focused pull requests are welcome.

## Before opening a change

- Open an issue first for new integrations or wire-contract changes.
- Keep Relay as the messaging transport. Agent runtimes keep ownership of
  models, prompts, tools, memory, and execution.
- Never include Agent Tokens, npm credentials, local state, or private
  conversation data in an issue, test fixture, commit, or pull request.

## Local checks

Requires Node 22.18 or newer.

```sh
npm ci
npm run validate
npm run validate:claude-plugin
npm run gateway:harness
npm run pack:check
npm audit --omit=dev --audit-level=high
```

The final two commands exercise installed artifacts rather than source imports.
Pull requests must keep the supported Linux and Windows matrix green.

## Release boundaries

Maintainers release from exact version tags through npm trusted publishing.
Contributors should not create release tags, publish packages, or add registry
tokens. The Claude Code and OpenClaw integrations are bundled in
`@relaymessenger/cli`; `@relaymessenger/vercel-ai` has its own release workflow.
`@relaymessenger/core` and everything under `examples/` are validated in CI but
not published; core stays unpublished until its types are generated from the
Relay-Server schemas.
