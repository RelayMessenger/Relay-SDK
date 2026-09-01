# Relay public developer monorepo

- This is the canonical public source for Relay's TypeScript SDK, Chat SDK
  adapter, CLI, MCP server, OpenClaw and Claude Code channels, portable Skill,
  generated Codex/Cursor distributions, and runnable Cookbook.
- `contracts/relay-v1-openapi.yaml` is the sole checked-in API authority.
  Package fixtures may copy it only when a validator proves byte identity.
- Preserve each published package's name, version, exports, executable names,
  and runtime behavior unless a release explicitly changes that contract.
- Standalone public repositories are generated mirrors or archived redirects,
  never independent editable sources.
- Relay receives agent events through signed Webhooks or the acknowledged
  agent-only WebSocket. Do not add polling or an invented transport.
- Keep private product code out of this repository. Relay Server, iOS,
  Console, Admin, Website, and the hosted Relay Agent remain separate.
- Load `.agents/skills/npm-package-authoring/SKILL.md` before changing package
  metadata, exports, tarballs, or publication workflows.
- Linux builds, package installations, and full validation run in Daytona.
- Never publish, deploy, archive a repository, or move a dist-tag unless the
  owner explicitly requests it.
