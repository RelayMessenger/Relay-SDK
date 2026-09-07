# Relay CLI

- This package directory owns only the public `@relaymessenger/cli` package.
- Use `@relaymessenger/sdk` resource methods and exported types. Do not copy
  OpenAPI schemas or call Relay HTTP routes directly.
- Agent Tokens are local server-side secrets. Never accept one as a command
  argument, print one, or include one in an error.
- The only event listener is the SDK's source-backed Agent WebSocket. Local
  development forwarding must remain loopback-only and must not claim to
  produce signed webhooks.
- Build and test on Linux only in a fresh Daytona sandbox.
- Do not push, publish, or deploy unless explicitly requested.
