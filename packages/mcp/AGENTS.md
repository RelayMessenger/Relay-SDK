# Relay MCP

- This package directory owns only the public `@relaymessenger/mcp` package.
- Implement the current MCP v2 stdio server with
  `@modelcontextprotocol/server`. Do not add a remote transport until its
  authentication, authorization, origin, session, and deployment model are
  explicitly designed and tested.
- Use `@relaymessenger/sdk` methods and types. Do not copy OpenAPI.
- Resolve Agent Tokens locally from environment or the Relay CLI profile file;
  tokens never belong in tool schemas, arguments, output, or logs.
- Build and test on Linux only in a fresh Daytona sandbox.
- Do not push, publish, or deploy unless explicitly requested.
