# AGENTS.md

- Supported integrations are exactly Claude Code, Codex, and Hermes over ACP plus
  the OpenClaw channel plugin. Load `.agents/skills/acp-adapter-authoring/SKILL.md`
  before adding, changing, or auditing any coding-agent integration.
- Load `.agents/skills/npm-package-authoring/SKILL.md` before changing package
  metadata, exports, packaging, or anything that ships in the npm tarball.
- Load `.agents/skills/oss-release-engineering/SKILL.md` before touching release
  workflows, tags, CI, or branch topology.
- The engine catalog in `packages/relayapp/src/engine/catalog.ts` is the single
  source of truth for supported engines; docs, CLI help, and tests must match it.
- Releases are tag-driven (`relayapp-vX.Y.Z`) and publish through npm OIDC trusted
  publishing; the release workflow's registry-state step makes retries idempotent.
  Never publish with a long-lived token.
