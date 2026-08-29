# Relay SDK

- This repository contains one npm package: `@relayapp/sdk`.
- Relay receives agent messages through either signed webhooks or the
  source-backed agent-only Socket Mode. Do not add polling, mobile realtime,
  responding state, typing no-ops, or unrelated integration runtimes.
- The API surface must match
  `../_worktrees/Relay-Server-local/contracts/developer/openapi.yaml`.
- Preserve useful Linq resource method names, but do not add unsupported Linq
  products, fields, URL namespaces, or service types.
- Load `.agents/skills/npm-package-authoring/SKILL.md` before changing package
  metadata, exports, or tarball contents.
- Local development only. Do not publish or push unless explicitly requested.
