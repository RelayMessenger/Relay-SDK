# AGENTS.md

- This repo is Relay-SDK, the single repo for building on Relay: the
  `@relaymessenger/cli` npm tool (the package name never changes), the runtime
  integrations it bundles, the `@relaymessenger/core` contract and transport
  library in `packages/core`, and the forkable agents in `examples/`.
- `@relaymessenger/core` is not published yet. Its types will become generated
  from the Relay-Server schemas; do not hand-grow the contract surface or add
  a release workflow for it without an owner ask.
- Supported integrations are exactly Claude Code, Codex, and Hermes over ACP,
  the OpenClaw channel plugin, and the Vercel AI SDK webhook plugin
  (`integrations/vercel-ai`, published as `@relaymessenger/vercel-ai`). Load `.agents/skills/acp-adapter-authoring/SKILL.md`
  before adding, changing, or auditing any coding-agent integration.
- Load `.agents/skills/npm-package-authoring/SKILL.md` before changing package
  metadata, exports, packaging, or anything that ships in the npm tarball.
- Load `.agents/skills/oss-release-engineering/SKILL.md` before touching release
  workflows, tags, CI, or branch topology.
- The engine catalog in `packages/relaymessenger/src/engine/catalog.ts` is the single
  source of truth for supported engines; docs, CLI help, and tests must match it.
- Releases are tag-driven (`relaymessenger-vX.Y.Z`) and publish through npm OIDC trusted
  publishing; the release workflow's registry-state step makes retries idempotent.
  Never publish with a long-lived token.
